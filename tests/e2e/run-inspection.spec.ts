import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { runDiagnosticBundleSchema, type ProjectDocument, type RunSummary } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function fixture(request: APIRequestContext) {
  let calls = 0;
  const server = createServer((request, response) => { request.resume(); calls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: `第 ${calls} 版生成风格` } }], usage: { prompt_tokens: 8, completion_tokens: 4 } })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('夹具服务没有启动');
  try {
    let project = await rpc<ProjectDocument>(request, 'project.create', { title: `步骤详情验收 ${randomUUID().slice(0, 8)}`, brief: '冻结的创作输入' });
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '执行时的模型', model: 'inspector-fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, capabilities: ['text'] }, secret: 'inspector-fixture-secret' });
    project = await rpc<ProjectDocument>(request, 'workflow.save', { projectId: project.id, workflow: { id: 'inspector-flow', version: 1, name: '验收流程', nodes: [{ id: 'style', kind: 'style', label: '冻结风格步骤', description: '固定本次创作的视觉风格', modelId: model.id, prompt: '按照创作输入生成风格' }, { id: 'review', kind: 'review', label: '人工核对', requiresReview: true }], edges: [{ id: 'style-review', source: 'style', target: 'review' }] } });
    async function start() {
      const run = await rpc<{ id: string }>(request, 'run.start', { projectId: project.id });
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toBe('waiting_review'); return run;
    }
    async function approve(runId: string) {
      await rpc(request, 'run.review', { runId, approved: true });
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId })).status).toBe('succeeded');
    }
    return { project, model, start, approve, server, calls: () => calls };
  } catch (error) { await close(server); throw error; }
}
async function open(page: Page, runId: string) {
  await page.goto('/'); await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '制作记录', exact: true }).click();
  const card = page.locator(`.run-card[data-run-id="${runId}"]`);
  await expect(card).toBeVisible(); await card.getByRole('button', { name: '查看步骤', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '制作步骤详情', exact: true }); await expect(dialog.getByRole('navigation', { name: '冻结流程步骤' })).toBeVisible(); return dialog;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
let pageErrors: string[] = [], consoleErrors: string[] = [], expectedErrors: string[] = [];
test.beforeEach(async ({ page }) => { pageErrors = []; consoleErrors = []; expectedErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); }); });
test.afterEach(async ({ page }) => { expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual(expectedErrors); await expect(page.locator('vite-error-overlay')).toHaveCount(0); });

test('reads native review and frozen inputs lazily, compares output versions, exports diagnostics and applies a selected version with undo', async ({ page, request }, info) => {
  const source = await fixture(request);
  try {
    const older = await source.start(); await source.approve(older.id); const newer = await source.start();
    const calls: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) calls.push(request.postDataJSON()?.method); });
    const dialog = await open(page, newer.id);
    await expect(dialog.getByRole('navigation', { name: '冻结流程步骤' })).toContainText('等待审阅');
    expect(calls).not.toContain('run.step.payload'); expect(calls).not.toContain('run.step.versions'); expect(calls).not.toContain('run.events');
    await dialog.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button', { name: /冻结风格步骤/ }).click();
    await expect(dialog.getByText('执行时的模型 · inspector-fixture', { exact: true })).toBeVisible();
    await dialog.getByRole('tab', { name: '执行输入', exact: true }).click();
    await expect(dialog.locator('.run-inspector__json')).toContainText('冻结的创作输入');
    await expect(dialog.locator('.run-inspector__json')).toContainText('按照创作输入生成风格');
    await expect(dialog).not.toContainText('inspector-fixture-secret');
    expect(await saved(request, source.project.id)).toEqual(source.project);
    await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '本次产物', exact: true })).toContainText('第 2 版生成风格');
    await dialog.getByRole('button', { name: '历史产物', exact: true }).click();
    await dialog.getByLabel('历史产物版本', { exact: true }).getByRole('button').filter({ hasText: older.id }).click();
    await expect(dialog.getByRole('region', { name: '历史产物', exact: true })).toContainText('第 1 版生成风格');
    expect(source.calls()).toBe(2);
    await dialog.getByRole('tab', { name: '活动与日志', exact: true }).click();
    await expect(dialog.locator('.run-inspector__activity')).toHaveCount(1);
    await expect(dialog.locator('.run-inspector__logs')).toContainText('冻结风格步骤');
    await dialog.getByRole('button', { name: '导出诊断', exact: true }).click();
    const downloadPromise = page.waitForEvent('download'); await dialog.getByRole('link', { name: '下载诊断文件', exact: true }).click();
    const path = info.outputPath('run-diagnostic.json.gz'); await (await downloadPromise).saveAs(path);
    const diagnostic = runDiagnosticBundleSchema.parse(JSON.parse(gunzipSync(await readFile(path)).toString()));
    expect(diagnostic.inspection.run.id).toBe(newer.id); expect(diagnostic.steps).toHaveLength(2);
    expect(JSON.stringify(diagnostic)).not.toContain('inspector-fixture-secret'); expect(source.calls()).toBe(2);
    await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click(); await dialog.getByRole('button', { name: '历史产物', exact: true }).click();
    await dialog.getByLabel('历史产物版本', { exact: true }).getByRole('button').filter({ hasText: older.id }).click();
    await expect(dialog.getByRole('region', { name: '历史产物', exact: true })).toContainText('第 1 版生成风格');
    await page.screenshot({ path: info.outputPath('run-history-comparison-dark.png') });
    await dialog.getByRole('button', { name: '在项目中查看与应用此版本', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
    await expect(output).toContainText('第 1 版生成风格'); await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await expect(output).toHaveCount(0);
    await expect.poll(async () => (await saved(request, source.project.id)).style).toBe('第 1 版生成风格');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, source.project.id)).style).toBe(source.project.style);
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await saved(request, source.project.id)).style).toBe('第 1 版生成风格');
    expect(source.calls()).toBe(2);
  } finally { await close(source.server); }
});

test('keeps late historical reads scoped and retains manual edits when an older output is applied', async ({ page, request }) => {
  const source = await fixture(request); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await source.start(); await source.approve(first.id); const second = await source.start(); await source.approve(second.id); const current = await source.start();
    const dialog = await open(page, current.id);
    await dialog.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button', { name: /冻结风格步骤/ }).click();
    await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click(); await dialog.getByRole('button', { name: '历史产物', exact: true }).click();
    let delayed = 0;
    await page.route('**/__desktop_rpc', async route => { const input = route.request().postDataJSON(); if (input.method === 'run.step.payload' && input.params.runId === first.id) { delayed++; const response = await route.fetch(); await gate; await route.fulfill({ response }); } else await route.continue(); });
    const versions = dialog.getByLabel('历史产物版本', { exact: true });
    await versions.getByRole('button').filter({ hasText: first.id }).click(); await expect.poll(() => delayed).toBe(1);
    await versions.getByRole('button').filter({ hasText: second.id }).click(); await expect(dialog.getByRole('region', { name: '历史产物', exact: true })).toContainText('第 2 版生成风格');
    release(); await expect(dialog.getByRole('region', { name: '历史产物', exact: true })).not.toContainText('第 1 版生成风格');
    const manual = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { style: '人工精修后保留的风格' } });
    await dialog.getByRole('button', { name: '在项目中查看与应用此版本', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true }); await expect(output).toContainText('第 2 版生成风格');
    expectedErrors = ['Failed to load resource: the server responded with a status of 400 (Bad Request)']; await output.getByRole('button', { name: '应用到项目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('项目已在生成后修改'); await expect(output).toBeVisible();
    expect(await saved(request, source.project.id)).toEqual(manual); expect(source.calls()).toBe(3);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await close(source.server); }
});

test('recovers a failed detail read explicitly and keeps tabs, tokens and actions usable in both themes at narrow width', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 600, height: 850 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = await fixture(request);
  let releaseFailure = () => {};
  try {
    const run = await source.start(); let failures = 0, inspectionReads = 0;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    let failureStarted = () => {};
    const started = new Promise<void>(resolve => { failureStarted = resolve; });
    await page.route('**/__desktop_rpc', async route => { const input = route.request().postDataJSON(); if (input.method === 'run.inspect' && !input.params.nodeId) inspectionReads++; if (!failures && input.method === 'run.inspect') { failures++; failureStarted(); await failureGate; await route.fulfill({ status: 500, json: { error: '隔离的步骤详情读取失败' } }); } else await route.continue(); });
    expectedErrors = ['Failed to load resource: the server responded with a status of 500 (Internal Server Error)']; await page.goto('/'); await page.getByRole('button', { name: '制作记录', exact: true }).click(); await page.locator(`.run-card[data-run-id="${run.id}"]`).getByRole('button', { name: '查看步骤', exact: true }).click();
    await started;
    const queued = await rpc<ProjectDocument>(request, 'project.create', { title: `详情读取期间通知 ${randomUUID().slice(0, 8)}` });
    await expect(page.locator('.sidebar-projects')).toContainText(queued.title);
    releaseFailure();
    const dialog = page.getByRole('dialog', { name: '制作步骤详情', exact: true }); await expect(dialog.getByRole('alert')).toContainText('隔离的步骤详情读取失败');
    const later = await rpc<ProjectDocument>(request, 'project.create', { title: `详情失败后通知 ${randomUUID().slice(0, 8)}` });
    await expect(page.locator('.sidebar-projects')).toContainText(later.title);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(inspectionReads).toBe(1); await expect(dialog.getByRole('alert')).toContainText('隔离的步骤详情读取失败');
    await dialog.getByRole('button', { name: '重试读取详情', exact: true }).click(); await expect(dialog.getByRole('navigation', { name: '冻结流程步骤' })).toBeVisible();
    await dialog.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button', { name: /冻结风格步骤/ }).click();
    const status = dialog.getByRole('tab', { name: '执行状态', exact: true }); await status.focus(); await status.press('ArrowRight'); await expect(dialog.getByRole('tab', { name: '执行输入', exact: true })).toBeFocused();
    await dialog.getByRole('tab', { name: '执行输入', exact: true }).press('End'); await expect(dialog.getByRole('tab', { name: '活动与日志', exact: true })).toBeFocused();
    await dialog.getByRole('tab', { name: '活动与日志', exact: true }).press('Home'); await expect(status).toBeFocused();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`run-inspector-${theme}-600.png`) });
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--text-size-label', '17px'));
    await expect(status).toHaveCSS('font-size', '17px'); await page.evaluate(() => document.documentElement.style.removeProperty('--text-size-label'));
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(page.locator(`.run-card[data-run-id="${run.id}"]`).getByRole('button', { name: '查看步骤', exact: true })).toBeFocused();
    expect(source.calls()).toBe(1);
  } finally { releaseFailure(); await close(source.server); }
});

test('handles a live step missing from an older run and uses the frozen kind for a renamed step output', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const run = await source.start(); await source.approve(run.id);
    const live = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, nodes: [...source.project.workflow.nodes.map(node => node.id === 'style' ? { ...node, label: '改名后的步骤', kind: 'brief' } : node), { id: 'new-step', kind: 'brief', label: '后加步骤' }] } } });
    await page.goto('/'); await page.getByRole('button', { name: `打开项目：${source.project.title}`, exact: true }).click();
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(source.project.title);
    await page.getByRole('tab', { name: '制作步骤', exact: true }).click(); await page.locator('.step-item').filter({ hasText: '后加步骤' }).click();
    const missing = page.getByRole('dialog', { name: '后加步骤', exact: true });
    expectedErrors = ['Failed to load resource: the server responded with a status of 400 (Bad Request)'];
    await missing.getByRole('button', { name: '查看最近产物', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('冻结流程中没有这个步骤');
    await expect(missing).toBeVisible(); await expect(page.getByRole('dialog', { name: '步骤产物', exact: true })).toHaveCount(0);
    await missing.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.step-item').filter({ hasText: '改名后的步骤' }).click();
    await page.getByRole('dialog', { name: '改名后的步骤', exact: true }).getByRole('button', { name: '查看最近产物', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
    await expect(output).toContainText('第 1 版生成风格'); await expect(output.getByRole('button', { name: '应用到项目', exact: true })).toBeVisible();
    expect(await saved(request, source.project.id)).toEqual(live); expect(source.calls()).toBe(1);
  } finally { await close(source.server); }
});
