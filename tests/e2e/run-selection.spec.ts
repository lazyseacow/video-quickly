import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type ProjectDocument, type RunInspection, type RunPlan, type RunRecord } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const payload = await response.json(); expect(response.ok()).toBe(true); expect(payload.error).toBeUndefined(); return payload.result;
}
async function fixture(request: APIRequestContext, review = false, exporting = false) {
  const created = await rpc<ProjectDocument>(request, 'project.create', { title: `执行范围验收 ${Date.now()}` });
  return rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [{ id: 'locked', title: '人工确认的镜头', narration: '保留人工旁白', visualPrompt: '', durationUs: 1_000_000, locked: true }],
    workflow: { id: 'scope', name: '局部执行', version: 1,
      nodes: [{ id: 'upstream', kind: 'brief', label: '上游资料' }, { id: 'start', kind: 'condition', label: '条件起点', requiresReview: review, config: { value: true } }, { id: 'yes', kind: 'brief', label: '条件命中' }, { id: 'no', kind: 'brief', label: '条件未命中' }, { id: 'join', kind: 'join', label: '汇合步骤' }, { id: 'tail', kind: 'brief', label: '收尾步骤' }, { id: 'outside', kind: 'brief', label: '独立分支' }, ...(exporting ? [{ id: 'export', kind: 'export', label: '导出成片' }] : [])],
      edges: [{ id: 'us', source: 'upstream', target: 'start' }, { id: 'sy', source: 'start', target: 'yes', condition: 'true' }, { id: 'sn', source: 'start', target: 'no', condition: 'false' }, { id: 'yj', source: 'yes', target: 'join' }, { id: 'nj', source: 'no', target: 'join' }, { id: 'oj', source: 'outside', target: 'join' }, { id: 'jt', source: 'join', target: 'tail' }, ...(exporting ? [{ id: 'te', source: 'tail', target: 'export' }] : [])],
    },
  } });
}
async function open(page: Page, project: ProjectDocument) {
  await page.goto('/'); await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill(project.title);
  await page.locator('.project-card').filter({ hasText: project.title }).getByRole('button', { name: '继续创作', exact: true }).click();
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(project.title);
  await page.getByRole('tab', { name: '制作步骤', exact: true }).click();
  await page.locator('.step-list').getByRole('button').filter({ hasText: '条件起点' }).click();
  return page.getByRole('dialog', { name: '条件起点', exact: true });
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

for (const viewport of [{ width: 1536, height: 960 }, { width: 600, height: 850 }, { width: 390, height: 844 }]) {
  test(`previews saved settings, both scope choices and actual boundary inputs without execution at ${viewport.width}px`, async ({ page, request }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
    const project = await fixture(request, true, true), editor = await open(page, project);
    await editor.getByLabel('提示词与补充要求').fill('预览前保存的条件说明');
    await editor.getByRole('button', { name: '预览这步及后续', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '执行范围', exact: true }), steps = dialog.getByRole('list', { name: '将执行的步骤' }).locator('li');
    await expect(steps).toHaveCount(6); await expect(dialog.getByText('需审阅', { exact: true })).toBeVisible(); await expect(dialog.getByText('导出文件', { exact: true })).toBeVisible();
    expect((await current(request, project.id)).workflow.nodes.find(node => node.id === 'start')?.prompt).toBe('预览前保存的条件说明');
    await dialog.getByText('沿用已保存的上游内容', { exact: true }).click();
    await expect(dialog.locator('.run-scope-boundary')).toContainText('上游资料'); await expect(dialog.locator('.run-scope-boundary')).toContainText('独立分支');
    const single = dialog.getByRole('radio', { name: '仅此步骤', exact: true }); await single.check(); await expect(steps).toHaveCount(1);
    await single.focus(); await single.press('ArrowRight'); await expect(dialog.getByRole('radio', { name: '此步骤及后续', exact: true })).toBeChecked(); await expect(steps).toHaveCount(6);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await expect(dialog.locator('.dialog__footer')).toBeInViewport({ ratio: 1 });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`run-scope-${theme}-${viewport.width}.png`) });
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--text-size-body', '17px')); await expect(steps.first().locator('strong')).toHaveCSS('font-size', '17px'); await page.evaluate(() => document.documentElement.style.removeProperty('--text-size-body'));
    expect((await runs(request, project.id)).items).toEqual([]);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(errors).toEqual([]);
  });
}

test('executes the confirmed dependent scope, skips the false branch and retains manual project content until application', async ({ page, request }) => {
  const project = await fixture(request), editor = await open(page, project);
  await editor.getByRole('button', { name: '预览这步及后续', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '执行范围', exact: true }); await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5);
  const saved = await current(request, project.id); expect((await runs(request, project.id)).items).toEqual([]);
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('succeeded');
  const run = (await runs(request, project.id)).items[0]; expect(run).toMatchObject({ selection: { nodeId: 'start', mode: 'downstream' }, stepCount: 5 });
  const inspection = await rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
  expect(Object.fromEntries(inspection.steps.map(step => [step.id, step.status]))).toEqual({ start: 'succeeded', yes: 'succeeded', no: 'skipped', join: 'succeeded', tail: 'succeeded' });
  expect(await current(request, project.id)).toEqual(saved);
  await page.getByRole('button', { name: '制作记录', exact: true }).click();
  const card = page.locator(`.run-card[data-run-id="${run.id}"]`); await expect(card).toContainText('所选步骤及后续');
  await expect(card.locator('.progress-line > span')).toHaveCSS('width', await card.locator('.progress-line').evaluate(element => `${element.clientWidth}px`));
  await card.getByRole('button', { name: '查看步骤', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: '制作步骤详情', exact: true }); await expect(inspector.getByRole('navigation', { name: '冻结流程步骤' }).getByRole('button')).toHaveCount(5);
});

test('keeps an obsolete preview open, rejects execution and starts only after the user confirms a refreshed plan', async ({ page, request }) => {
  expectedErrors = ['status of 400 (Bad Request)'];
  const project = await fixture(request); let previous: unknown, hold = true, submissions = 0;
  await page.route('**/__desktop_rpc', async route => {
    const input = route.request().postDataJSON(); if (input.method === 'run.start') submissions++;
    if (input.method !== 'run.plan') { await route.continue(); return; }
    const response = await route.fetch(), payload = await response.json(); previous ??= payload.result;
    await route.fulfill({ response, json: { result: hold ? previous : payload.result } });
  });
  const editor = await open(page, project); await editor.getByRole('button', { name: '预览这步及后续', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '执行范围', exact: true }); await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5);
  const before = await current(request, project.id), changed = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: before.revision, patch: { brief: '另一视图的新输入' } });
  await expect(page.getByText(`修订 ${changed.revision}`, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('重新预览');
  expect((await runs(request, project.id)).items).toEqual([]); expect(submissions).toBe(1);
  hold = false; await dialog.getByRole('button', { name: '重新预览', exact: true }).click(); await expect(dialog.locator('.run-scope-summary dd').first()).toHaveText(String(changed.revision));
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('succeeded'); expect(submissions).toBe(2); expect(await current(request, project.id)).toEqual(changed);
});

test('previews the original scope when restarting from either the task list or its step inspector', async ({ page, request }) => {
  const project = await fixture(request, true), preview = await rpc<RunPlan>(request, 'run.plan', { projectId: project.id, selection: { nodeId: 'start', mode: 'downstream' } });
  const parent = await rpc<RunRecord>(request, 'run.start', { projectId: project.id, selection: { ...preview.selection, previewDigest: preview.digest } });
  await expect.poll(async () => (await rpc<RunRecord>(request, 'run.get', { runId: parent.id })).status).toBe('waiting_review'); await rpc(request, 'run.cancel', { runId: parent.id });
  await page.goto('/'); await page.getByRole('button', { name: '制作记录', exact: true }).click();
  await page.locator(`.run-card[data-run-id="${parent.id}"]`).getByRole('button', { name: '重新制作', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '执行范围', exact: true }); await expect(dialog).toContainText('沿用原任务范围'); await expect(dialog.getByRole('radio')).toHaveCount(0); await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5);
  expect((await runs(request, project.id)).items).toHaveLength(1); await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('waiting_review');
  const restarted = (await runs(request, project.id)).items[0]; expect(restarted).toMatchObject({ parentRunId: parent.id, selection: preview.selection }); expect(restarted.id).not.toBe(parent.id);
  await rpc(request, 'run.cancel', { runId: restarted.id });
  const card = page.locator(`.run-card[data-run-id="${restarted.id}"]`); await card.getByRole('button', { name: '查看步骤', exact: true }).click();
  await page.getByRole('dialog', { name: '制作步骤详情', exact: true }).getByRole('button', { name: '重新制作', exact: true }).click();
  await expect(dialog).toContainText('沿用原任务范围'); await expect(dialog.locator('.run-scope-steps li')).toHaveCount(5); expect((await runs(request, project.id)).items).toHaveLength(2);
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
});

test('renders a real MP4 when the confirmed downstream scope includes export without applying results to the project', async ({ page, request }) => {
  const created = await fixture(request, false, true);
  const project = await rpc<ProjectDocument>(request, 'project.update', { projectId: created.id, revision: created.revision, patch: { profile: { ...created.profile, width: 320, height: 180 } } });
  const editor = await open(page, project); await editor.getByRole('button', { name: '预览这步及后续', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '执行范围', exact: true }); await expect(dialog.getByText('导出文件', { exact: true })).toBeVisible();
  const saved = await current(request, project.id); await dialog.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status, { timeout: 30_000 }).toBe('succeeded');
  const run = (await runs(request, project.id)).items[0], result = await rpc<{ videoPath: string }>(request, 'node.result', { runId: run.id, nodeId: 'export' });
  expect((await readFile(result.videoPath)).subarray(4, 8).toString()).toBe('ftyp');
  const probe = JSON.parse(execFileSync(process.env.VIDEO_QUICKLY_FFPROBE ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', result.videoPath], { encoding: 'utf8', windowsHide: true }));
  expect(probe.streams[0]).toMatchObject({ width: 320, height: 180 }); expect(await current(request, project.id)).toEqual(saved);
});
