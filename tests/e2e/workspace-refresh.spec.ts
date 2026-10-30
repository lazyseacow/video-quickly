import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
let pageErrors: string[] = [], consoleErrors: string[] = [], expectedHttpErrors = 0;
test.beforeEach(async ({ page }) => {
  pageErrors = []; consoleErrors = []; expectedHttpErrors = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual(Array.from({ length: expectedHttpErrors }, () => 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)'));
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('renders a completed project read while a later notification refresh is still pending', async ({ page, request }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `慢读取通知交错 ${randomUUID().slice(0, 8)}` });
  const target = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'target-shot', title: '目标镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  const unrelated = await rpc<ProjectDocument>(request, 'project.create', { title: '通知来源项目' });
  let notifications = 0;
  page.on('websocket', socket => socket.on('framereceived', frame => { if (String(frame.payload).includes('workspace.changed')) notifications++; }));
  const network = await page.context().newCDPSession(page); await network.send('Network.enable');
  network.on('Network.eventSourceMessageReceived', event => { if (event.data.includes('workspace.changed')) notifications++; });
  await page.goto('/'); await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: target.title, exact: true }) });
  await expect(card).toBeVisible(); await page.clock.install();
  const firstRead = gate(), laterRead = gate(), requested = gate(); let reads = 0;
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.method !== 'project.get' || input.params?.projectId !== target.id) { await route.continue(); return; }
    const number = ++reads, response = await route.fetch(); requested.release();
    await (number === 1 ? firstRead.promise : laterRead.promise); await route.fulfill({ response });
  });
  try {
    await card.getByRole('button', { name: /继续创作/ }).click(); await requested.promise;
    const before = notifications;
    await rpc(request, 'project.update', { projectId: unrelated.id, revision: unrelated.revision, patch: { title: '通知来源项目已更新' } });
    await expect.poll(() => notifications).toBeGreaterThan(before);
    // Run the real notification debounce while the first selected-project read
    // is held. A newer read must not discard this matching complete response.
    await page.clock.runFor(300); firstRead.release();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('目标镜头');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('refresh-visible.png') });
  } finally { firstRead.release(); laterRead.release(); await page.clock.resume(); }
});

async function targetProject(request: APIRequestContext, shotTitle: string) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `${shotTitle} ${randomUUID().slice(0, 8)}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'shot', title: shotTitle, narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
}

test('opens the selected project while unrelated workspace metadata is delayed', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const target = await targetProject(request, '摘要尚未返回的镜头');
  await page.goto('/'); await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const hold = gate(); let summaries = 0;
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method !== 'workspace.summary') { await route.continue(); return; }
    summaries++; const response = await route.fetch(); await hold.promise; await route.fulfill({ response });
  });
  try {
    await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: target.title, exact: true }) }).getByRole('button', { name: /继续创作/ }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('摘要尚未返回的镜头');
    expect(summaries).toBeGreaterThan(0); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { hold.release(); }
});

test('keeps the newer selection when the previous project response arrives late', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await targetProject(request, '先选择的镜头'), second = await targetProject(request, '后选择的镜头');
  await page.goto('/'); await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
  const hold = gate(), requested = gate(), finished = gate();
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.method !== 'project.get' || input.params?.projectId !== first.id) { await route.continue(); return; }
    const response = await route.fetch(); requested.release(); await hold.promise; await route.fulfill({ response }); finished.release();
  });
  try {
    await page.getByRole('button', { name: `打开项目：${first.title}`, exact: true }).click(); await requested.promise;
    await page.getByRole('button', { name: `打开项目：${second.title}`, exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('后选择的镜头');
    hold.release(); await finished.promise;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('后选择的镜头');
  } finally { hold.release(); }
});

test('shows a failed selected-project read and recovers only after an explicit new read', async ({ page, request }) => {
  expectedHttpErrors = 1;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const target = await targetProject(request, '读取恢复的镜头');
  await page.goto('/'); await expect(page.getByLabel('镜头标题', { exact: true })).toBeVisible();
  let reads = 0;
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.method !== 'project.get' || input.params?.projectId !== target.id) { await route.continue(); return; }
    reads++; if (reads === 1) { await route.fulfill({ status: 500, json: { error: '隔离的项目读取失败' } }); return; } await route.continue();
  });
  await page.getByRole('button', { name: `打开项目：${target.title}`, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('隔离的项目读取失败'); expect(reads).toBe(1);
  await page.getByRole('button', { name: '重试项目', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('读取恢复的镜头'); expect(reads).toBe(2);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
