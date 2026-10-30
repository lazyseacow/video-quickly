import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function rpc(request: APIRequestContext, method: string, params: unknown = {}) {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}
async function createProject(request: APIRequestContext, title: string, shotCount = 2) {
  const project = await rpc(request, 'project.create', { title });
  return rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: Array.from({ length: shotCount }, (_, index) => ({ id: `shot-${index}`, title: `测试镜头 ${index + 1}`, narration: '', visualPrompt: '', durationUs: 2_000_000 })) } });
}
async function openProject(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.locator('.project-card').filter({ hasText: title }).getByRole('button', { name: /继续创作/ }).click();
  await expect(page.getByLabel('镜头标题')).toBeVisible();
}

test('undoes and redoes grouped input, ordering, duplication and deletion with monotonic saved revisions', async ({ page, request }) => {
  const project = await createProject(request, '统一编辑历史验收');
  await openProject(page, project.title);
  const title = page.getByLabel('镜头标题');
  await title.fill('连续'); await title.pressSequentially('输入');
  await title.press('ControlOrMeta+z'); await expect(title).toHaveValue('测试镜头 1');
  await title.press('ControlOrMeta+Shift+z'); await expect(title).toHaveValue('连续输入');
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  let saved = (await rpc(request, 'project.get', { projectId: project.id })).project;
  expect(saved.revision).toBe(project.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(title).toHaveValue('测试镜头 1');
  await expect.poll(async () => (await rpc(request, 'project.get', { projectId: project.id })).project.revision).toBe(saved.revision + 1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(title).toHaveValue('连续输入');
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '将镜头后移', exact: true }).click();
  await expect(page.locator('.outline-shot').first()).toContainText('测试镜头 2');
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '复制镜头', exact: true }).click();
  await expect(page.locator('.outline-shot')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '移除所选镜头', exact: true }).click();
  await expect(page.locator('.outline-shot')).toHaveCount(2);
  for (const count of [3, 2, 2]) {
    await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.outline-shot')).toHaveCount(count);
  }
  await expect(page.locator('.outline-shot').first()).toContainText('连续输入');
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  saved = (await rpc(request, 'project.get', { projectId: project.id })).project;
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.outline-shot').first()).toContainText('测试镜头 2');
  await expect.poll(async () => (await rpc(request, 'project.get', { projectId: project.id })).project.revision).toBe(saved.revision + 1);
});

test('restores an unsaved multi-field draft and resolves external edits without losing either side', async ({ page, request }, info) => {
  const project = await createProject(request, '草稿恢复与冲突验收');
  await openProject(page, project.title);
  await page.getByLabel('镜头标题').fill('草稿标题');
  await page.getByLabel('旁白', { exact: true }).fill('重启后仍保留的旁白');
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('video-quickly-drafts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    return new Promise<boolean>(resolve => { const query = db.transaction('projects').objectStore('projects').getAll(); query.onsuccess = () => { resolve(query.result.some(value => value.present.shots[0]?.narration === '重启后仍保留的旁白')); db.close(); }; });
  })).toBe(true);
  page.once('dialog', dialog => dialog.accept()); await page.reload();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('草稿标题');
  await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('重启后仍保留的旁白');
  await expect(page.getByText('已恢复未保存的本地草稿，含撤销与重做历史。')).toBeVisible();
  const remote = await rpc(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map((shot: { id: string }) => shot.id === 'shot-0' ? { ...shot, title: '另一视图的标题', visualPrompt: '另一视图的画面' } : shot) } });
  await page.getByRole('button', { name: '比较并处理', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '比较草稿与已保存内容' });
  await expect(comparison).toContainText('草稿标题'); await expect(comparison).toContainText('另一视图的标题');
  await expect(comparison.locator('.dialog__surface')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('draft-conflict-dark.png') });
  await comparison.getByLabel('已保存内容', { exact: true }).check();
  await comparison.getByRole('button', { name: '合并所选内容', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('另一视图的标题');
  await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('重启后仍保留的旁白');
  await expect(page.getByLabel('画面要求')).toHaveValue('另一视图的画面');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
  const saved = (await rpc(request, 'project.get', { projectId: project.id })).project;
  expect(saved.revision).toBe(remote.revision + 1);
  expect(saved.shots[0]).toMatchObject({ title: '另一视图的标题', narration: '重启后仍保留的旁白', visualPrompt: '另一视图的画面' });
  await page.getByRole('button', { name: '浅色外观', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 900 });
  await page.screenshot({ path: info.outputPath('draft-restored-light-600.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('loads 200 shots without snapshot or hidden historical reads and keeps controls responsive', async ({ page, request }, info) => {
  const project = await createProject(request, '两百镜头读取验收', 200);
  const methods: string[] = []; const errors: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) methods.push(request.postDataJSON().method); });
  page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await openProject(page, project.title);
  await expect(page.locator('.outline-shot')).toHaveCount(200);
  const openMs = Date.now() - started;
  const editStarted = Date.now();
  await page.getByLabel('镜头标题').fill('大项目中的编辑');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('测试镜头 1');
  const editMs = Date.now() - editStarted;
  const selectStarted = Date.now();
  await page.locator('.outline-shot').last().click();
  await expect(page.getByLabel('镜头标题')).toHaveValue('测试镜头 200');
  const selectMs = Date.now() - selectStarted;
  const ruler = page.getByRole('slider', { name: '预览播放位置' });
  await ruler.press('End'); await expect(ruler).toHaveAttribute('aria-valuenow', '399967');
  const cdp = await page.context().newCDPSession(page);
  const heap = await cdp.send('Runtime.getHeapUsage'); await cdp.detach();
  await page.screenshot({ path: info.outputPath('large-project-dark-1536.png') });
  expect(methods).not.toContain('workspace.snapshot'); expect(methods).not.toContain('run.events'); expect(methods).not.toContain('run.activities'); expect(methods).not.toContain('run.list'); expect(methods).not.toContain('asset.list');
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const metrics = { shots: 200, openMs, editAndUndoMs: editMs, selectLastShotMs: selectMs, heapUsedMiB: Math.round(heap.usedSize / 1024 / 1024 * 100) / 100, methods };
  await writeFile(info.outputPath('large-project-metrics.json'), JSON.stringify(metrics, null, 2));
  await info.attach('large-project-interactions', { body: JSON.stringify(metrics), contentType: 'application/json' });
});

test('keeps generated results editable with undo and rejects reapplying them after revisions', async ({ page, request }) => {
  const server = createServer((incoming, response) => {
    incoming.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ id: 'generated', title: '已生成的分镜', narration: '生成的旁白', visualPrompt: '', durationUs: 2_000_000 }] }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('模型夹具未启动');
  try {
    const original = await createProject(request, '产物应用历史验收');
    const model = await rpc(request, 'model.save', { model: { name: '隔离的分镜服务', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text'] } });
    const workflow = { ...original.workflow, nodes: original.workflow.nodes.map((node: { kind: string }) => node.kind === 'script' ? { ...node, modelId: model.id } : node) };
    const project = await rpc(request, 'workflow.save', { projectId: original.id, revision: original.revision, workflow });
    const run = await rpc(request, 'run.start', { projectId: project.id, nodeId: 'script' });
    await expect.poll(async () => (await rpc(request, 'project.get', { projectId: project.id })).latestRun.status).toBe('waiting_review');
    await rpc(request, 'node.apply', { runId: run.id, nodeId: 'script', revision: project.revision });
    await openProject(page, project.title);
    await expect(page.getByLabel('镜头标题')).toHaveValue('已生成的分镜');
    await page.getByRole('tab', { name: '制作步骤', exact: true }).click();
    await page.locator('.step-item').filter({ hasText: '旁白与分镜' }).click();
    const step = page.getByRole('dialog', { name: '旁白与分镜', exact: true });
    await expect(step.getByRole('button', { name: '保存', exact: true })).toBeVisible();
    await expect(step.getByRole('button', { name: '执行', exact: true })).toBeVisible();
    await expect(step.getByRole('button', { name: '查看最近产物', exact: true })).toHaveCount(0);
    await step.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByLabel('镜头标题').fill('人工修订的分镜');
    await page.getByRole('button', { name: '保存镜头', exact: true }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByLabel('镜头标题')).toHaveValue('已生成的分镜');
    await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.getByLabel('镜头标题')).toHaveValue('人工修订的分镜');
    await expect(page.getByRole('button', { name: '保存镜头', exact: true })).toBeDisabled();
    const stale = await request.post('/__desktop_rpc', { data: { method: 'node.apply', params: { runId: run.id, nodeId: 'script' } } });
    expect((await stale.json()).error).toContain('项目已在生成后修改');
    await rpc(request, 'run.cancel', { runId: run.id });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('separates adjacent layout controls and keeps both monochrome themes usable at desktop and narrow sizes', async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const project = await createProject(request, '灰阶主题交互验收');
  await openProject(page, project.title);
  await expect(page).toHaveTitle(/Video Quickly/);
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') await page.getByRole('button', { name: '浅色外观', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const controls = page.locator('.editor-layout-actions > button');
    const first = await controls.nth(0).boundingBox(); const second = await controls.nth(1).boundingBox();
    if (!first || !second) throw new Error('布局按钮不可见');
    expect(second.x - first.x - first.width).toBeGreaterThanOrEqual(7.5);
    await page.getByRole('button', { name: '收起镜头导航', exact: true }).focus();
    await page.keyboard.press('Space'); await expect(page.locator('#project-outline')).toBeHidden();
    await page.getByRole('button', { name: '显示镜头导航', exact: true }).click();
    await expect(page.locator('#project-outline')).toBeVisible();
    await page.getByText('画面预览', { exact: true }).click();
    await page.screenshot({ path: info.outputPath(`monochrome-${theme}-1536.png`) });
  }
  await page.setViewportSize({ width: 600, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('monochrome-light-600.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建视频项目', exact: true });
  await expect(dialog.getByLabel('项目名称', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0); expect(errors).toEqual([]);
});
