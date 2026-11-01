import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(request: APIRequestContext, name: string, count = 2) {
  const project = await rpc<ProjectDocument>(request, 'project.create', { title: `${name} ${randomUUID().slice(0, 8)}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: Array.from({ length: count }, (_, index) => ({ id: `shot-${index}`, title: `镜头 ${index}`, narration: '', visualPrompt: '', durationUs: 1_000_000 })) } });
}
async function openProject(page: Page, project: ProjectDocument) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const origin = new Date('2026-01-01T00:00:00Z'); await page.clock.install({ time: origin });
  await page.goto('/'); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的项目', exact: true }).click(); await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue(project.shots[0].title);
  await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(project.revision));
  // Hold notification debounce timers while exercising the explicit save read.
  // Each scenario later advances the real timer to inspect its own notifications.
  await page.clock.pauseAt(new Date(origin.getTime() + 2 * test.info().timeout));
}
function observe(page: Page) {
  const errors = { page: [] as string[], console: [] as string[] };
  page.on('pageerror', error => errors.page.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.console.push(entry.text()); });
  return errors;
}
async function observeNotifications(page: Page) {
  let count = 0;
  const network = await page.context().newCDPSession(page); await network.send('Network.enable');
  network.on('Network.eventSourceMessageReceived', event => { if (event.data.includes('workspace.changed')) count++; });
  return () => count;
}
async function healthy(page: Page, errors: ReturnType<typeof observe>, expected500 = 0) {
  await expect(page).toHaveTitle(/Video Quickly/); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors.page).toEqual([]); expect(errors.console).toEqual(Array.from({ length: expected500 }, () => 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)'));
}

test('uses a confirmed save revision without rereading the large project and still refreshes assets and external edits', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '保存回执条件读取', 200);
  const notifications = await observeNotifications(page);
  type Read = { revision?: number; assetsVersion?: number; returnedRevision: number; projectRevision?: number; assetIds?: string[]; bytes: number };
  const reads: Read[] = []; let committed: ProjectDocument | undefined;
  await openProject(page, project);
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.params?.projectId !== project.id || !['project.update', 'project.get'].includes(input.method)) { await route.continue(); return; }
    const response = await route.fetch(), payload = await response.json();
    if (input.method === 'project.update') committed = payload.result;
    else reads.push({ revision: input.params.revision, assetsVersion: input.params.assetsVersion, returnedRevision: payload.result.revision, projectRevision: payload.result.project?.revision, assetIds: payload.result.assets?.map((asset: AssetRecord) => asset.id), bytes: Buffer.byteLength(JSON.stringify(payload)) });
    await route.fulfill({ response });
  });
  try {
    // An acknowledged save drains the existing selected-project read queue.
    // Keep notification timers paused so the measured save starts without an
    // older background read, which intentionally uses the conservative path.
    await page.getByLabel('镜头标题', { exact: true }).fill('连续编辑前的保存'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    expect(committed?.revision).toBe(project.revision + 1); reads.length = 0; committed = undefined;
    await page.getByLabel('镜头标题', { exact: true }).fill('已确认保存的镜头'); await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    expect(committed?.revision).toBe(project.revision + 2); expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ revision: committed!.revision, returnedRevision: committed!.revision });
    expect(reads[0].projectRevision).toBeUndefined(); expect(reads[0].assetIds).toBeUndefined(); expect(reads[0].bytes).toBeLessThan(1000);

    const path = info.outputPath('save-refreshed-asset.svg'); await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const beforeAsset = notifications(), asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'image' });
    await expect.poll(notifications).toBeGreaterThan(beforeAsset); await page.clock.runFor(300);
    await expect.poll(() => reads.some(read => read.returnedRevision === committed!.revision && read.projectRevision === undefined && read.assetIds?.includes(asset.id))).toBe(true);
    await expect(page.getByLabel('画面素材', { exact: true }).getByRole('option', { name: asset.name, exact: true })).toHaveCount(1);

    const beforeExternal = notifications(), external = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: committed!.revision, patch: { title: '外部更新仍能显示' } });
    await expect.poll(notifications).toBeGreaterThan(beforeExternal); await page.clock.runFor(300);
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(external.title);
    expect(reads.some(read => read.revision === committed!.revision && read.projectRevision === external.revision)).toBe(true);
    const evidence = info.outputPath('conditional-project-reads.json'); await writeFile(evidence, JSON.stringify(reads, null, 2));
    await info.attach('conditional-project-reads', { path: evidence, contentType: 'application/json' });
    await healthy(page, errors);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});

test('keeps an older in-flight read and input made during a confirmed save isolated from the next fresh read', async ({ page, request }) => {
  const errors = observe(page), project = await fixture(request, '保存与在途读取交错');
  const notifications = await observeNotifications(page);
  const unrelated = await rpc<ProjectDocument>(request, 'project.create', { title: `在途通知来源 ${randomUUID().slice(0, 8)}` });
  const hold = gate(), entered = gate(), committed = gate(); let held = false; const revisions: Array<number | undefined> = [];
  await openProject(page, project);
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.params?.projectId !== project.id || !['project.get', 'project.update'].includes(input.method)) { await route.continue(); return; }
    const response = await route.fetch();
    if (input.method === 'project.update') { await route.fulfill({ response }); committed.release(); return; }
    revisions.push(input.params.revision);
    if (!held) { held = true; entered.release(); await hold.promise; }
    await route.fulfill({ response });
  });
  try {
    const before = notifications(); await rpc(request, 'project.update', { projectId: unrelated.id, revision: unrelated.revision, patch: { title: '启动真实后台读取' } });
    await expect.poll(notifications).toBeGreaterThan(before); await page.clock.runFor(300); await entered.promise;
    await page.getByLabel('镜头标题', { exact: true }).fill('已保存的并发镜头'); await page.getByRole('button', { name: '保存镜头', exact: true }).click(); await committed.promise;
    await page.getByLabel('旁白', { exact: true }).fill('保存期间继续输入');
    const stored = (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project;
    expect(stored.revision).toBe(project.revision + 1); expect(stored.shots[0].narration).toBe('');
    hold.release(); await expect(page.locator('.project-heading-copy')).toHaveAttribute('data-revision', String(stored.revision));
    await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeEnabled();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('已保存的并发镜头'); await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('保存期间继续输入');
    expect(revisions.length).toBeGreaterThanOrEqual(2); expect(revisions[1]).toBe(project.revision);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('已保存的并发镜头'); await healthy(page, errors);
  } finally { hold.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});

test('shows an explicit retry for a failed background read while preserving a loaded project and its unsaved history', async ({ page, request }, info) => {
  const errors = observe(page), project = await fixture(request, '已加载项目读取恢复');
  const unrelated = await rpc<ProjectDocument>(request, 'project.create', { title: `恢复通知来源 ${randomUUID().slice(0, 8)}` });
  let reads = 0;
  const notifications = await observeNotifications(page);
  await openProject(page, project);
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.method !== 'project.get' || input.params?.projectId !== project.id) { await route.continue(); return; }
    reads++; if (reads === 1) { await route.fulfill({ status: 500, json: { error: '已加载项目的隔离读取故障' } }); return; }
    await route.continue();
  });
  try {
    await page.getByLabel('镜头标题', { exact: true }).fill('读取故障仍保留的草稿');
    const before = notifications(); await rpc(request, 'project.update', { projectId: unrelated.id, revision: unrelated.revision, patch: { title: '触发背景读取' } });
    await expect.poll(notifications).toBeGreaterThan(before); await page.clock.runFor(300);
    await expect(page.getByRole('alert')).toContainText('已加载项目的隔离读取故障');
    await expect(page.getByRole('button', { name: '重新读取项目', exact: true })).toBeVisible();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('读取故障仍保留的草稿');
    await page.screenshot({ path: info.outputPath('loaded-project-read-retry.png') });
    const external = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { title: '显式恢复后的远端标题' } });
    const after = notifications(); await rpc(request, 'project.update', { projectId: unrelated.id, revision: unrelated.revision + 1, patch: { title: '失败后仍有真实通知' } });
    await expect.poll(notifications).toBeGreaterThan(after); await page.clock.runFor(300);
    expect(reads).toBe(1); await expect(page.getByRole('alert')).toContainText('已加载项目的隔离读取故障');
    await page.getByRole('button', { name: '重新读取项目', exact: true }).click();
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(external.title);
    await expect(page.getByRole('button', { name: '重新读取项目', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('读取故障仍保留的草稿');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue(project.shots[0].title);
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(external.title);
    expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: project.id })).project.shots[0].title).toBe(project.shots[0].title);
    await healthy(page, errors, 1);
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});
