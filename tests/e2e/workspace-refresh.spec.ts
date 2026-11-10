import { openProjectFromList } from './workspace-navigation';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { projectDetailSchema, type ProjectDetail, type ProjectDocument } from '@video-quickly/contracts';

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
  await page.goto('/'); await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
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
  await page.goto('/'); await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
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
  await page.goto('/'); await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  const hold = gate(), requested = gate(), finished = gate();
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.method !== 'project.get' || input.params?.projectId !== first.id) { await route.continue(); return; }
    const response = await route.fetch(); requested.release(); await hold.promise; await route.fulfill({ response }); finished.release();
  });
  try {
    await openProjectFromList(page, first.title, { waitForReady: false }); await requested.promise;
    await openProjectFromList(page, second.title);
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
  const clockOrigin = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: clockOrigin });
  await page.goto('/'); await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  // Other workers can publish real workspace changes after recovery. Keep
  // their debounce outside this explicit-read count; notifications are tested below.
  await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
  try {
    let reads = 0;
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON();
      if (input?.method !== 'project.get' || input.params?.projectId !== target.id) { await route.continue(); return; }
      reads++; if (reads === 1) { await route.fulfill({ status: 500, json: { error: '隔离的项目读取失败' } }); return; } await route.continue();
    });
    await openProjectFromList(page, target.title, { waitForReady: false });
    await expect(page.getByRole('alert')).toContainText('隔离的项目读取失败'); expect(reads).toBe(1);
    await page.getByRole('button', { name: '重试项目', exact: true }).click();
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('读取恢复的镜头'); expect(reads).toBe(2);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await page.clock.resume(); }
});

test('keeps a failed project read paused through actual workspace notifications until explicit retry', async ({ page, request }) => {
  expectedHttpErrors = 1;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const target = await targetProject(request, '通知后仍需显式恢复的镜头');
  const unrelated = await targetProject(request, '失败期间的通知来源');
  let notifications = 0, reads = 0;
  const network = await page.context().newCDPSession(page); await network.send('Network.enable');
  network.on('Network.eventSourceMessageReceived', event => { if (event.data.includes('workspace.changed')) notifications++; });
  await page.goto('/'); await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  const clockOrigin = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: clockOrigin }); await page.clock.pauseAt(new Date(clockOrigin.getTime() + 2 * test.info().timeout));
  const retryRequested = gate(), releaseRetry = gate(), conditionalRead = gate();
  type Phase = 'failed' | 'retry' | 'notification';
  let phase: Phase = 'failed', latestReply: ProjectDetail | undefined;
  const observed: Array<{ phase: Phase; params: { projectId: string; revision?: number; assetsVersion?: number }; baseline?: { revision: number; assetsVersion: number }; reply?: ProjectDetail }> = [];
  const writes: string[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/__desktop_rpc')) return;
    const method = request.postDataJSON()?.method;
    if (['project.update', 'run.start', 'run.resume', 'run.retry', 'run.review', 'run.cancel'].includes(method)) writes.push(method);
  });
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON();
    if (input?.method !== 'project.get' || input.params?.projectId !== target.id) { await route.continue(); return; }
    const number = ++reads, record: typeof observed[number] = { phase, params: input.params, baseline: latestReply ? { revision: latestReply.revision, assetsVersion: latestReply.assetsVersion } : undefined }; observed.push(record);
    if (number === 1) { await route.fulfill({ status: 500, json: { error: '通知不能自动重试的项目读取失败' } }); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200);
    record.reply = projectDetailSchema.parse((await response.json()).result); latestReply = record.reply;
    if (number === 2) { retryRequested.release(); await releaseRetry.promise; }
    await route.fulfill({ response });
    if (number > 2) conditionalRead.release();
  });
  try {
    await openProjectFromList(page, target.title, { waitForReady: false });
    await expect(page.getByRole('alert')).toContainText('通知不能自动重试的项目读取失败');
    const before = notifications;
    const notified = await rpc<ProjectDocument>(request, 'project.update', { projectId: unrelated.id, revision: unrelated.revision, patch: { title: '实际通知已发出' } });
    await expect.poll(() => notifications).toBeGreaterThan(before);
    await page.clock.runFor(300);
    await expect(page.getByRole('alert')).toContainText('通知不能自动重试的项目读取失败');
    expect(reads).toBe(1);
    phase = 'retry'; await page.getByRole('button', { name: '重试项目', exact: true }).click(); await retryRequested.promise;
    const beforeRecoveryNotification = notifications; phase = 'notification';
    await rpc(request, 'project.update', { projectId: unrelated.id, revision: notified.revision, patch: { title: '恢复期间的实际通知' } });
    await expect.poll(() => notifications).toBeGreaterThan(beforeRecoveryNotification);
    await page.clock.runFor(300); releaseRetry.release(); await conditionalRead.promise;
    await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('通知后仍需显式恢复的镜头');
    const projectRead = { projectId: target.id, videoPreviewKey: '' };
    expect(observed.filter(read => read.phase === 'failed').map(read => read.params)).toEqual([projectRead]);
    const retried = observed.filter(read => read.phase === 'retry'); expect(retried).toHaveLength(1);
    expect(retried[0].params).toEqual(projectRead); expect(retried[0].reply?.project).toEqual(target);
    const refreshed = observed.filter(read => read.phase === 'notification'); expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed[0].baseline).toEqual({ revision: retried[0].reply!.revision, assetsVersion: retried[0].reply!.assetsVersion });
    // Once explicitly recovered, notifications resume normal conditional reads.
    // A later asset-library update may advance the response's assetsVersion.
    for (const read of refreshed) {
      expect(read.baseline).toBeDefined(); expect(read.params).toEqual({ ...projectRead, ...read.baseline });
      expect(read.reply?.id).toBe(target.id); expect(read.reply?.revision).toBe(target.revision);
    }
    expect(writes).toEqual([]); expect((await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId: target.id })).project).toEqual(target);
  } finally { releaseRetry.release(); await page.unrouteAll({ behavior: 'wait' }); await page.clock.resume(); }
});
