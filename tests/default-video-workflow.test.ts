import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeVideoWorkflow, projectSchema, resolveWorkflowStages, runSchema, validateWorkflowComposition, workflowSchema, type ActivityRecord, type ProjectDocument, type RecordPage } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function open(directory: string) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-default-workflow', provider: async () => { throw new Error('默认流程检查不得请求模型。'); } }); runtimes.add(runtime); return runtime;
}
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'vq-default-workflow-')); directories.push(directory); return { directory, runtime: open(directory) }; }
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) { return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project; }
const leafIds = ['brief', 'style', 'script', 'assets', 'video', 'animation', 'export'];
const stageLayout = [
  { id: 'planning', label: '策划与分镜', nodeIds: ['brief', 'style', 'script'] },
  { id: 'materials', label: '素材与配音', nodeIds: ['assets', 'video'] },
  { id: 'editing', label: '剪辑与动画', nodeIds: ['animation'] },
  { id: 'delivery', label: '审阅与导出', nodeIds: ['export'] },
];

it('groups the seven independently configurable tasks into four ordered generic production stages', () => {
  const workflow = workflowSchema.parse(createNativeVideoWorkflow());
  expect(workflow).toMatchObject({ id: 'native-video', name: '视频制作' });
  expect(workflow.nodes.map(node => node.id)).toEqual(leafIds); expect(workflow.nodes.filter(node => node.kind === 'animation')).toHaveLength(2);
  expect(workflow.stages?.map(({ id, label, nodeIds }) => ({ id, label, nodeIds }))).toEqual(stageLayout);
  expect(workflow.nodes.filter(node => node.requiresReview).map(node => node.id)).toEqual([]);
  expect(workflow.edges.map(edge => [edge.source, edge.target])).toEqual(leafIds.slice(1).map((id, index) => [leafIds[index], id]));
  expect(() => validateWorkflowComposition(workflow)).not.toThrow();
  const resolved = resolveWorkflowStages(workflow);
  expect(resolved.map(stage => stage.nodes.map(node => node.id))).toEqual(stageLayout.map(stage => stage.nodeIds));
  for (const stage of resolved) expect(stage.nodes).toEqual(stage.nodeIds.map(id => workflow.nodes.find(node => node.id === id)));
});

it('uses the same four-stage tasks without research or review waits for historical projects', () => {
  const workflow = createNativeVideoWorkflow();
  expect(workflow.nodes.map(node => node.id)).toEqual(leafIds);
  expect(workflow.nodes.every(node => !node.requiresReview)).toBe(true);
  expect(workflow.stages).toEqual(createNativeVideoWorkflow().stages);
});

it('creates empty generic projects with the same default workflow when copying series display settings', async () => {
  const { runtime } = await fixture();
  const template = await runtime.dispatch('seriesTemplate.save', { template: { name: '显示设置不覆盖流程', description: '', settings: { style: '通用产品演示', captionStyle: null, scenePreset: null } } }) as { id: string; revision: number };
  for (const params of [{ title: '通用新项目' }, { title: '系列新项目', seriesTemplateId: template.id, seriesTemplateRevision: template.revision }]) {
    const project = projectSchema.parse(await runtime.dispatch('project.create', params));
    expect(project).toMatchObject({ templateId: 'generic', shots: [], claims: [], revision: 1 }); expect(project.workflow).toEqual(createNativeVideoWorkflow());
    expect(project.style).toBe('seriesTemplateId' in params ? '通用产品演示' : '');
    expect(await current(runtime, project.id)).toEqual(project); expect(await runtime.dispatch('run.list', { projectId: project.id })).toMatchObject({ items: [] });
  }
});

it('automatically executes an explicit custom workflow with saved review settings and preserves its frozen results after reopening', async () => {
  const { directory, runtime } = await fixture();
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '保留的自定义审核流程' }));
  const legacy = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: { ...createNativeVideoWorkflow(), id: 'custom-reviewed-workflow', nodes: createNativeVideoWorkflow().nodes.map(node => node.id === 'style' ? { ...node, requiresReview: true, config: {} } : node) } } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: legacy.id, nodeId: 'style' })); await runtime.waitForIdle();
  const before = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })); expect(before.status).toBe('succeeded');
  const events = await runtime.dispatch('run.events', { runId: run.id }) as { items: { type: string }[] };
  expect(events.items.some(event => event.type === 'review.waiting')).toBe(false);
  await runtime.close(); runtimes.delete(runtime); const reopened = open(directory);
  expect(await current(reopened, legacy.id)).toEqual(legacy);
  expect(runSchema.parse(await reopened.dispatch('run.get', { runId: run.id }))).toEqual(before);
  const fresh = projectSchema.parse(await reopened.dispatch('project.create', { title: '重开后的新项目' })); expect(fresh.workflow).toEqual(createNativeVideoWorkflow()); expect(fresh.templateId).toBe('generic');
  expect(await current(reopened, legacy.id)).toEqual(legacy);
  const finished = runSchema.parse(await reopened.dispatch('run.get', { runId: run.id })); expect(finished.status).toBe('succeeded'); expect(finished.snapshotDigest).toBe(before.snapshotDigest);
  const activities = await reopened.dispatch('run.activities', { runId: run.id }) as RecordPage<ActivityRecord>; expect(activities.items.map(activity => activity.id)).toEqual(['style']);
  expect(await current(reopened, legacy.id)).toEqual(legacy); expect(await reopened.dispatch('run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
});
