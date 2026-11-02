import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, createVideoWorkflow, projectSchema, resolveWorkflowStages, runSchema, validateWorkflowComposition, workflowSchema, type ActivityRecord, type ProjectDocument, type RecordPage } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function open(directory: string) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-default-workflow', provider: async () => { throw new Error('默认流程检查不得请求模型。'); } }); runtimes.add(runtime); return runtime;
}
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'vq-default-workflow-')); directories.push(directory); return { directory, runtime: open(directory) }; }
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) { return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project; }
const leafIds = ['brief', 'style', 'script', 'assets', 'voice', 'animation', 'review', 'export'];
const stageLayout = [
  { id: 'planning', label: '策划与分镜', nodeIds: ['brief', 'style', 'script'] },
  { id: 'materials', label: '素材与配音', nodeIds: ['assets', 'voice'] },
  { id: 'editing', label: '剪辑与动画', nodeIds: ['animation'] },
  { id: 'delivery', label: '审阅与导出', nodeIds: ['review', 'export'] },
];

it('groups the eight independently configurable tasks into four ordered generic production stages', () => {
  const workflow = workflowSchema.parse(createVideoWorkflow());
  expect(workflow).toMatchObject({ id: 'general-video', name: '通用视频制作' });
  expect(workflow.nodes.map(node => node.id)).toEqual(leafIds); expect(workflow.nodes.map(node => node.kind)).toEqual(leafIds);
  expect(workflow.stages?.map(({ id, label, nodeIds }) => ({ id, label, nodeIds }))).toEqual(stageLayout);
  expect(workflow.nodes.filter(node => node.requiresReview).map(node => node.id)).toEqual(['script', 'review']);
  expect(workflow.edges.map(edge => [edge.source, edge.target])).toEqual(leafIds.slice(1).map((id, index) => [leafIds[index], id]));
  expect(() => validateWorkflowComposition(workflow)).not.toThrow();
  const resolved = resolveWorkflowStages(workflow);
  expect(resolved.map(stage => stage.nodes.map(node => node.id))).toEqual(stageLayout.map(stage => stage.nodeIds));
  for (const stage of resolved) expect(stage.nodes).toEqual(stage.nodeIds.map(id => workflow.nodes.find(node => node.id === id)));
});

it('keeps the legacy factory, research task and ungrouped project payload intact when resolving stages', () => {
  const workflow = createHistoryWorkflow(), before = structuredClone(workflow);
  expect(workflow.stages).toBeUndefined(); expect(workflow.nodes.map(node => node.id)).toEqual(['brief', 'research', 'style', 'script', 'assets', 'voice', 'animation', 'review', 'export']);
  expect(workflow.nodes.filter(node => node.requiresReview).map(node => node.id)).toEqual(['style', 'script', 'review']);
  expect(resolveWorkflowStages(workflow).flatMap(stage => stage.nodes.map(node => node.id))).toEqual(workflow.nodes.map(node => node.id));
  expect(workflow).toEqual(before); expect(workflowSchema.parse(workflow)).toEqual(before);
});

it('creates empty generic projects with the same default workflow when copying series display settings', async () => {
  const { runtime } = await fixture();
  const template = await runtime.dispatch('seriesTemplate.save', { template: { name: '显示设置不覆盖流程', description: '', settings: { style: '通用产品演示', captionStyle: null, scenePreset: null } } }) as { id: string; revision: number };
  for (const params of [{ title: '通用新项目' }, { title: '系列新项目', seriesTemplateId: template.id, seriesTemplateRevision: template.revision }]) {
    const project = projectSchema.parse(await runtime.dispatch('project.create', params));
    expect(project).toMatchObject({ templateId: 'generic', shots: [], claims: [], revision: 1 }); expect(project.workflow).toEqual(createVideoWorkflow());
    expect(project.style).toBe('seriesTemplateId' in params ? '通用产品演示' : '');
    expect(await current(runtime, project.id)).toEqual(project); expect(await runtime.dispatch('run.list', { projectId: project.id })).toMatchObject({ items: [] });
  }
});

it('reopens a legacy project and its active review without replacing either with the new default', async () => {
  const { directory, runtime } = await fixture();
  const legacy = projectSchema.parse(await runtime.dispatch('project.create', { title: '保留的历史项目', templateId: 'history-handdrawn' })); expect(legacy.workflow).toEqual(createHistoryWorkflow());
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: legacy.id, nodeId: 'style' })); await runtime.waitForIdle();
  const before = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id })); expect(before.status).toBe('waiting_review');
  await runtime.close(); runtimes.delete(runtime); const reopened = open(directory);
  expect(await current(reopened, legacy.id)).toEqual(legacy);
  expect(runSchema.parse(await reopened.dispatch('run.get', { runId: run.id }))).toEqual(before);
  const fresh = projectSchema.parse(await reopened.dispatch('project.create', { title: '重开后的新项目' })); expect(fresh.workflow).toEqual(createVideoWorkflow()); expect(fresh.templateId).toBe('generic');
  expect(await current(reopened, legacy.id)).toEqual(legacy);
  await reopened.dispatch('run.review', { runId: run.id, approved: true }); await reopened.waitForIdle();
  const finished = runSchema.parse(await reopened.dispatch('run.get', { runId: run.id })); expect(finished.status).toBe('succeeded'); expect(finished.snapshotDigest).toBe(before.snapshotDigest);
  const activities = await reopened.dispatch('run.activities', { runId: run.id }) as RecordPage<ActivityRecord>; expect(activities.items.map(activity => activity.id)).toEqual(['style']);
  expect(await current(reopened, legacy.id)).toEqual(legacy); expect(await reopened.dispatch('run.replay', { runId: run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
});
