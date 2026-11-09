import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type ProjectDocument, type RunInspection, type RunPlan, type RunRecord } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext, exporting = false) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `执行范围验收 ${Date.now()}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'locked', title: '人工确认的镜头', narration: '保留人工旁白', visualPrompt: '', durationUs: 1_000_000, locked: true }],
    workflow: { id: 'scope', name: '局部执行', version: 1,
      production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [{ id: 'upstream', kind: 'brief', label: '上游资料' }, { id: 'start', kind: 'condition', label: '条件起点', config: { value: true } }, { id: 'yes', kind: 'brief', label: '条件命中' }, { id: 'no', kind: 'brief', label: '条件未命中' }, { id: 'join', kind: 'join', label: '汇合步骤' }, { id: 'tail', kind: 'brief', label: '收尾步骤' }, { id: 'outside', kind: 'brief', label: '独立分支' }, ...(exporting ? [{ id: 'export', kind: 'export', label: '导出成片' }] : [])],
      edges: [{ id: 'us', source: 'upstream', target: 'start' }, { id: 'sy', source: 'start', target: 'yes', condition: 'true' }, { id: 'sn', source: 'start', target: 'no', condition: 'false' }, { id: 'yj', source: 'yes', target: 'join' }, { id: 'nj', source: 'no', target: 'join' }, { id: 'oj', source: 'outside', target: 'join' }, { id: 'jt', source: 'join', target: 'tail' }, ...(exporting ? [{ id: 'te', source: 'tail', target: 'export' }] : [])],
    },
  } });
}
async function startScopedRun(request: APIRequestContext, projectId: string) {
  const plan = await rpc<RunPlan>(request, 'run.plan', { projectId, selection: { nodeId: 'start', mode: 'downstream' } });
  return rpc<RunRecord>(request, 'run.start', { projectId, selection: { ...plan.selection, previewDigest: plan.digest } });
}
async function restartFixture(request: APIRequestContext) {
  let calls = 0, ready = false;
  const server = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => {
      calls++;
      if (!ready) return;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: '已完成收尾' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local scope fixture did not start');
    const created = await fixture(request);
    const model = await rpc<{ id: string }>(request, 'model.save', { model: { name: '可取消的本地步骤', provider: 'openai-compatible', model: 'local-scope', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionType: 'text', capabilities: ['text'] } });
    const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { workflow: { ...created.workflow, nodes: created.workflow.nodes.map(node => node.id === 'tail' ? { ...node, modelId: model.id } : node) } } });
    const parent = await startScopedRun(request, project.id);
    await expect.poll(() => calls).toBe(1); await rpc(request, 'run.cancel', { runId: parent.id });
    await expect.poll(async () => (await rpc<RunRecord>(request, 'run.get', { runId: parent.id })).status).toBe('canceled');
    return { project, parent, calls: () => calls, finishNext: () => { ready = true; }, close };
  } catch (error) { await close(); throw error; }
}
async function openRestart(page: Page, runId: string) {
  await page.goto('/'); await page.getByRole('button', { name: '制作记录', exact: true }).click();
  await page.locator(`.run-card[data-run-id="${runId}"]`).getByRole('button', { name: '重新制作', exact: true }).click();
  return page.getByRole('dialog', { name: '执行范围', exact: true });
}
const runs = (request: APIRequestContext, projectId: string) => rpc<{ items: RunRecord[] }>(request, 'run.list', { projectId });
const current = async (request: APIRequestContext, projectId: string) => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
let browserErrors: string[] = [], expectedErrors: string[] = [];
test.beforeEach(({ page }) => {
  browserErrors = []; expectedErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
});
test.afterEach(() => { expect(browserErrors.filter(message => !expectedErrors.some(expected => message.includes(expected)))).toEqual([]); });

test('executes the confirmed dependent scope, skips the false branch and retains manual project content until application', async ({ page, request }) => {
  const project = await fixture(request);
  const run = await startScopedRun(request, project.id);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('succeeded');
  expect(run).toMatchObject({ selection: { nodeId: 'start', mode: 'downstream' }, stepCount: 5 });
  const inspection = await rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
  expect(Object.fromEntries(inspection.steps.map(step => [step.id, step.status]))).toEqual({ start: 'succeeded', yes: 'succeeded', no: 'skipped', join: 'succeeded', tail: 'succeeded' });
  expect(await current(request, project.id)).toEqual(project);
  await page.goto('/'); await page.getByRole('button', { name: '制作记录', exact: true }).click();
  const card = page.locator(`.run-card[data-run-id="${run.id}"]`); await expect(card).toContainText('所选步骤及后续');
  await expect(card.locator('.progress-line > span')).toHaveCSS('width', await card.locator('.progress-line').evaluate(element => `${element.clientWidth}px`));
  await card.getByRole('button', { name: '查看步骤', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: '制作步骤详情', exact: true }); await expect(inspector.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button')).toHaveCount(5);
});

test('keeps a completed execution plan usable while an unrelated workspace update is being checked', async ({ page, request }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = await restartFixture(request), { parent, project } = source;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const dialog = await openRestart(page, parent.id);
    const confirm = dialog.getByRole('button', { name: '确认执行', exact: true });
    await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5); await expect(confirm).toBeEnabled();
    await expect(dialog.getByRole('button', { name: '重新预览', exact: true })).toHaveCount(0);
    await page.route('**/__desktop_rpc', async route => {
      if (route.request().postDataJSON()?.method !== 'run.plan') { await route.continue(); return; }
      const response = await route.fetch(); await held; await route.fulfill({ response });
    });
    await rpc(request, 'project.create', { title: '不影响当前执行范围的项目' });
    await expect(dialog.getByText('正在核对执行范围…', { exact: true })).toBeVisible();
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: info.outputPath('run-scope-refresh-usable.png') });
    source.finishNext();
    await confirm.click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('succeeded');
    const completed = (await runs(request, project.id)).items;
    expect(completed).toHaveLength(2); expect(completed[0]).toMatchObject({ parentRunId: parent.id, projectRevision: project.revision, selection: parent.selection, stepCount: 5 });
    expect(await current(request, project.id)).toEqual(project);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await source.close(); }
});

test('keeps an obsolete preview open, rejects execution and starts only after the user confirms a refreshed plan', async ({ page, request }) => {
  expectedErrors = ['status of 400 (Bad Request)'];
  const source = await restartFixture(request), { parent, project } = source;
  let previous: unknown, hold = true, submissions = 0;
  try {
    await page.route('**/__desktop_rpc', async route => {
      const input = route.request().postDataJSON(); if (input.method === 'run.start') submissions++;
      if (input.method !== 'run.plan') { await route.continue(); return; }
      const response = await route.fetch(), payload = await response.json(); previous ??= payload.result;
      await route.fulfill({ response, json: { result: hold ? previous : payload.result } });
    });
    const dialog = await openRestart(page, parent.id);
    await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5);
    const changed = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: { brief: '另一视图的新输入' } });
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('重新预览');
    expect((await runs(request, project.id)).items.map(run => run.id)).toEqual([parent.id]); expect(submissions).toBe(1);
    hold = false; await dialog.getByRole('button', { name: '重新预览', exact: true }).click(); await expect(dialog.locator('.run-scope-summary dd').first()).toHaveText(String(changed.revision));
    source.finishNext();
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('succeeded');
    expect(submissions).toBe(2); expect(await current(request, project.id)).toEqual(changed);
  } finally { await source.close(); }
});

for (const width of [1536, 390]) test(`previews the original scope from the task list and step inspector at ${width}px`, async ({ page, request }, info) => {
  const source = await restartFixture(request), { parent, project } = source;
  try {
    await page.setViewportSize({ width, height: 844 });
    const dialog = await openRestart(page, parent.id);
    await expect(dialog).toContainText('沿用原任务范围');
    await expect(dialog.getByRole('radio')).toHaveCount(0); await expect(dialog.getByLabel('起始步骤')).toHaveCount(0);
    await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5);
    await dialog.getByText('沿用已保存的上游内容', { exact: true }).click();
    await expect(dialog.locator('.run-scope-boundary')).toContainText('上游资料');
    await expect(dialog.locator('.run-scope-boundary')).toContainText('独立分支');
    await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`saved-scope-${width}.png`) });
    expect((await runs(request, project.id)).items).toHaveLength(1);
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(source.calls).toBe(2);
    const restarted = (await runs(request, project.id)).items[0];
    expect(restarted).toMatchObject({ parentRunId: parent.id, selection: parent.selection }); expect(restarted.id).not.toBe(parent.id);
    await rpc(request, 'run.cancel', { runId: restarted.id });
    const card = page.locator(`.run-card[data-run-id="${restarted.id}"]`); await card.getByRole('button', { name: '查看步骤', exact: true }).click();
    await page.getByRole('dialog', { name: '制作步骤详情', exact: true }).getByRole('button', { name: '重新制作', exact: true }).click();
    await expect(dialog).toContainText('沿用原任务范围'); await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5);
    expect((await runs(request, project.id)).items).toHaveLength(2);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  } finally { await source.close(); }
});

test('renders a real MP4 from a saved downstream scope without applying results to the project', async ({ request }) => {
  const created = await fixture(request, true);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { profile: { ...created.profile, width: 320, height: 180 } } });
  const run = await startScopedRun(request, project.id);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status, { timeout: 30_000 }).toBe('succeeded');
  const result = await rpc<{ videoPath: string }>(request, 'node.result', { runId: run.id, nodeId: 'export' });
  expect((await readFile(result.videoPath)).subarray(4, 8).toString()).toBe('ftyp');
  const probe = JSON.parse(execFileSync(process.env.VIDEO_QUICKLY_FFPROBE ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', result.videoPath], { encoding: 'utf8', windowsHide: true }));
  expect(probe.streams[0]).toMatchObject({ width: 320, height: 180 }); expect(await current(request, project.id)).toEqual(project);
});
