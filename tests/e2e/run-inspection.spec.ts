import { openAdvancedWorkflow } from './production-settings';
import { confirmAction } from './confirmation-actions';
import { openProjectFromList } from './workspace-navigation';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './isolated-workspace';
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
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '执行时的模型', model: 'inspector-fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'] }, secret: 'inspector-fixture-secret' });
    project = await rpc<ProjectDocument>(request, 'workflow.save', { projectId: project.id, workflow: { id: 'inspector-flow', version: 1, name: '验收流程', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [{ id: 'style', kind: 'style', label: '冻结风格步骤', description: '固定本次创作的视觉风格', modelId: model.id, prompt: '按照创作输入生成风格' }, { id: 'review', kind: 'review', label: '自动检查', requiresReview: true }], edges: [{ id: 'style-review', source: 'style', target: 'review' }] } });
    async function start() {
      const run = await rpc<{ id: string }>(request, 'run.start', { projectId: project.id, nodeId: 'style' });
      await expect.poll(async () => (await rpc<RunSummary>(request, 'run.get', { runId: run.id })).status).toBe('succeeded'); return run;
    }
    return { project, model, start, server, calls: () => calls };
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

test('shows the selected run output, exports diagnostics and applies it with undo', async ({ page, request }, info) => {
  const source = await fixture(request);
  try {
    await source.start(); const newer = await source.start();
    const calls: Array<{ method: string; kind?: string }> = [];
    page.on('request', request => { if (request.url().endsWith('/__desktop_rpc')) { const input = request.postDataJSON(); calls.push({ method: input.method, kind: input.params?.kind }); } });
    const dialog = await open(page, newer.id);
    await expect(dialog.getByRole('navigation', { name: '冻结流程步骤' })).toContainText('已完成');
    await dialog.getByRole('tab', { name: '制作信息', exact: true }).click();
    await expect(dialog).not.toContainText('人工审阅');
    expect(calls.filter(call => call.kind === 'input')).toEqual([]); expect(calls.map(call => call.method)).not.toContain('run.step.versions'); expect(calls.map(call => call.method)).not.toContain('run.events');
    await dialog.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button', { name: /冻结风格步骤/ }).click();
    await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '历史产物', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('region', { name: '本次产物', exact: true })).toContainText('第 2 版生成风格');
    await expect(dialog.getByRole('tab', { name: '执行输入', exact: true })).toHaveCount(0);
    await dialog.getByRole('tab', { name: '制作信息', exact: true }).click();
    await expect(dialog.getByText('执行时的模型 · inspector-fixture', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('冻结的创作输入'); await expect(dialog).not.toContainText('inspector-fixture-secret');
    expect(calls.filter(call => call.kind === 'input')).toEqual([]);
    await dialog.locator('.run-inspector__prompt-toggle > summary').click();
    const prompt = dialog.getByRole('region', { name: '本次提示词记录', exact: true });
    await expect(prompt).toContainText('按照创作输入生成风格');
    await expect(prompt).toContainText('冻结的创作输入');
    await expect(prompt).not.toContainText('inspector-fixture-secret');
    expect(calls.filter(call => call.kind === 'input')).toHaveLength(1);
    await dialog.locator('.run-inspector__logs-toggle > summary').click();
    await expect(dialog.locator('.run-inspector__activity')).toHaveCount(1);
    await dialog.locator('.run-inspector__tools > summary').click(); await dialog.getByRole('button', { name: '导出诊断', exact: true }).click();
    const downloadPromise = page.waitForEvent('download'); await dialog.getByRole('link', { name: '下载诊断文件', exact: true }).click();
    const path = info.outputPath('run-diagnostic.json.gz'); await (await downloadPromise).saveAs(path);
    const diagnostic = runDiagnosticBundleSchema.parse(JSON.parse(gunzipSync(await readFile(path)).toString()));
    expect(diagnostic.inspection.run.id).toBe(newer.id); expect(diagnostic.steps).toHaveLength(1);
    expect(JSON.stringify(diagnostic)).toContain('冻结的创作输入'); expect(JSON.stringify(diagnostic)).not.toContain('inspector-fixture-secret');
    await dialog.locator('.run-inspector__tools > summary').click(); await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click();
    await dialog.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
    await expect(output).toContainText('第 2 版生成风格'); await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await confirmAction(page, '确认应用'); await expect(output).toHaveCount(0);
    await expect.poll(async () => (await saved(request, source.project.id)).style).toBe('第 2 版生成风格');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await saved(request, source.project.id)).style).toBe(source.project.style);
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await saved(request, source.project.id)).style).toBe('第 2 版生成风格');
    expect(source.calls()).toBe(2); expect(calls.map(call => call.method)).not.toContain('run.step.versions');
  } finally { await close(source.server); }
});

test('retains manual project changes when applying an inspected output would overwrite them', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const run = await source.start(); const dialog = await open(page, run.id);
    await dialog.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button', { name: /冻结风格步骤/ }).click();
    await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click();
    const manual = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { style: '人工精修后保留的风格' } });
    await dialog.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true }); await expect(output).toContainText('第 1 版生成风格');
    expectedErrors = ['Failed to load resource: the server responded with a status of 400 (Bad Request)']; await output.getByRole('button', { name: '应用到项目', exact: true }).click(); await confirmAction(page, '确认应用');
    await expect(page.getByRole('alert')).toContainText('项目已在生成后修改'); await expect(output).toBeVisible();
    expect(await saved(request, source.project.id)).toEqual(manual); expect(source.calls()).toBe(1);
  } finally { await close(source.server); }
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
    const queuedTitle = `详情读取期间通知 ${randomUUID().slice(0, 8)}`;
    const queuedRefresh = page.waitForResponse(async response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'workspace.summary' && (await response.json()).result.projects.some((project: ProjectDocument) => project.title === queuedTitle));
    await rpc(request, 'project.create', { title: queuedTitle }); await queuedRefresh;
    releaseFailure();
    const dialog = page.getByRole('dialog', { name: '制作步骤详情', exact: true }); await expect(dialog.getByRole('alert')).toContainText('隔离的步骤详情读取失败');
    const laterTitle = `详情失败后通知 ${randomUUID().slice(0, 8)}`;
    const laterRefresh = page.waitForResponse(async response => response.url().endsWith('/__desktop_rpc') && response.request().postDataJSON()?.method === 'workspace.summary' && (await response.json()).result.projects.some((project: ProjectDocument) => project.title === laterTitle));
    await rpc(request, 'project.create', { title: laterTitle }); await laterRefresh;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(inspectionReads).toBe(1); await expect(dialog.getByRole('alert')).toContainText('隔离的步骤详情读取失败');
    await dialog.getByRole('button', { name: '重试读取详情', exact: true }).click(); await expect(dialog.getByRole('navigation', { name: '冻结流程步骤' })).toBeVisible();
    await dialog.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button', { name: /冻结风格步骤/ }).click();
    const status = dialog.getByRole('tab', { name: '制作信息', exact: true }), result = dialog.getByRole('tab', { name: '步骤产物', exact: true });
    await expect(dialog.getByRole('tab', { name: '执行输入', exact: true })).toHaveCount(0);
    await result.focus(); await result.press('ArrowRight'); await expect(status).toBeFocused();
    await status.press('Home'); await expect(result).toBeFocused(); await result.press('End'); await expect(status).toBeFocused();
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

test('keeps new live steps out of older runs and uses the frozen kind for a renamed step output', async ({ page, request }) => {
  const source = await fixture(request);
  try {
    const run = await source.start();
    const live = await rpc<ProjectDocument>(request, 'project.update', { projectId: source.project.id, revision: source.project.revision, patch: { workflow: { ...source.project.workflow, nodes: [...source.project.workflow.nodes.map(node => node.id === 'style' ? { ...node, label: '改名后的步骤', kind: 'brief' } : node), { id: 'new-step', kind: 'brief', label: '后加步骤', position: { x: 640, y: 0 } }] } } });
    await page.goto('/'); await openProjectFromList(page, source.project.title);
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(source.project.title);
    await openAdvancedWorkflow(page);
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.getByRole('button', { name: '适应全部步骤', exact: true }).click();
    await page.locator('.react-flow__node[data-id="new-step"]').click();
    await page.getByRole('button', { name: '配置与执行步骤', exact: true }).click();
    const missing = page.getByRole('dialog', { name: '后加步骤', exact: true });
    await expect(missing.getByLabel('提示词与补充要求', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '步骤产物', exact: true })).toHaveCount(0);
    await missing.getByRole('button', { name: '取消', exact: true }).click();
    const dialog = await open(page, run.id);
    const steps = dialog.getByRole('navigation', { name: '冻结流程步骤' });
    await expect(steps).not.toContainText('后加步骤');
    await expect(steps).not.toContainText('改名后的步骤');
    await steps.getByRole('button', { name: /冻结风格步骤/ }).click();
    await dialog.getByRole('tab', { name: '步骤产物', exact: true }).click();
    await expect(dialog.getByRole('region', { name: '本次产物', exact: true })).toContainText('第 1 版生成风格');
    await dialog.getByRole('button', { name: '在项目中查看与应用', exact: true }).click();
    const output = page.getByRole('dialog', { name: '步骤产物', exact: true });
    await expect(output).toContainText('第 1 版生成风格'); await expect(output.getByRole('button', { name: '应用到项目', exact: true })).toBeVisible();
    expect(await saved(request, source.project.id)).toEqual(live); expect(source.calls()).toBe(1);
  } finally { await close(source.server); }
});
