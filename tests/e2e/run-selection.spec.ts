import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { openProjectFromList } from './workspace-navigation';
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
const runs = (request: APIRequestContext, projectId: string) => rpc<{ items: RunRecord[] }>(request, 'run.list', { projectId });
const current = async (request: APIRequestContext, projectId: string) => (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project;
let browserErrors: string[] = [];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
});
test.afterEach(() => { expect(browserErrors).toEqual([]); });

test('executes the confirmed dependent scope, skips the false branch and retains manual project content until application', async ({ page, request }) => {
  const project = await fixture(request);
  const run = await startScopedRun(request, project.id);
  await expect.poll(async () => (await runs(request, project.id)).items[0]?.status).toBe('succeeded');
  expect(run).toMatchObject({ selection: { nodeId: 'start', mode: 'downstream' }, stepCount: 5 });
  const inspection = await rpc<RunInspection>(request, 'run.inspect', { runId: run.id });
  expect(Object.fromEntries(inspection.steps.map(step => [step.id, step.status]))).toEqual({ start: 'succeeded', yes: 'succeeded', no: 'skipped', join: 'succeeded', tail: 'succeeded' });
  expect(await current(request, project.id)).toEqual(project);
  await page.goto('/'); await openProjectFromList(page, project.title);
  await page.getByRole('button', { name: '打开步骤：条件命中', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: '本次制作', exact: true });
  await expect(inspector.getByRole('navigation', { name: '本阶段制作步骤', exact: true })).toContainText('条件命中');
  await expect(inspector.getByRole('region', { name: '本次产物', exact: true })).toBeVisible();
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
