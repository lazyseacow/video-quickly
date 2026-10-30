import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, type ProjectDocument, type RunRecord, type WorkspaceSummary } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';

const runtimes: ReturnType<typeof createRuntime>[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(join(tmpdir(), 'vq-workflow-save-'))) throw new Error('Unexpected cleanup directory');
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-workflow-save-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); runtimes.push(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '流程事务' }));
  const project = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: created.id, revision: created.revision, workflow: { id: 'graph', name: '原流程', version: 1, nodes: [{ id: 'a', kind: 'brief', label: '简报', requiresReview: true }, { id: 'b', kind: 'brief', label: '提案' }], edges: [{ id: 'ab', source: 'a', target: 'b' }] } }));
  const current = async () => (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  return { runtime, project, current };
}

it('commits graph and project edits in one revision and owns workflow version increments', async () => {
  const { runtime, project, current } = await setup();
  const workflow = { ...project.workflow, version: 999, nodes: project.workflow.nodes.map(node => node.id === 'a' ? { ...node, prompt: '人工微调' } : node) };
  const result = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '同步保存的项目名称', workflow } }));
  expect(result.revision).toBe(project.revision + 1); expect(result.workflow.version).toBe(project.workflow.version + 1);
  expect(result.title).toBe('同步保存的项目名称'); expect(result.workflow.nodes[0].prompt).toBe('人工微调');
  const repeated = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: result.revision, patch: { brief: '仅改简报', workflow: { ...result.workflow, version: 888 } } }));
  expect(repeated.workflow.version).toBe(result.workflow.version); expect(repeated.revision).toBe(result.revision + 1);
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '旧窗口修改', workflow } })).rejects.toThrow('其他视图');
  expect(await current()).toEqual(repeated);
  expect((await runtime.dispatch('run.list', { projectId: project.id }) as { items: RunRecord[] }).items).toEqual([]);
  expect(await runtime.dispatch('cost.summary', { projectId: project.id })).toMatchObject({ total: 0 });
});

it('rejects invalid dependency graphs before committing other fields, revisions or workspace events', async () => {
  const { runtime, project, current } = await setup();
  const before = await runtime.dispatch('workspace.summary') as WorkspaceSummary;
  for (const workflow of [
    { ...project.workflow, nodes: [project.workflow.nodes[0], project.workflow.nodes[0]] },
    { ...project.workflow, edges: [{ id: 'dangling', source: 'a', target: 'missing' }] },
    { ...project.workflow, edges: [...project.workflow.edges, { id: 'cycle', source: 'b', target: 'a' }] },
    { ...project.workflow, nodes: [] },
    { ...project.workflow, nodes: project.workflow.nodes.map(node => ({ ...node, label: '' })) },
  ]) {
    await expect(runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '应回滚的标题', workflow } })).rejects.toThrow();
    expect(await current()).toEqual(project);
    expect((await runtime.dispatch('workspace.summary') as WorkspaceSummary).version).toBe(before.version);
  }
});

it('keeps an already-started workflow frozen through editing and human review', async () => {
  const { runtime, project, current } = await setup();
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord;
  await runtime.waitForIdle();
  expect((await runtime.dispatch('run.list', { projectId: project.id }) as { items: RunRecord[] }).items[0]).toMatchObject({ id: run.id, status: 'waiting_review' });
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: (await current()).revision, patch: { workflow: { ...project.workflow, nodes: [...project.workflow.nodes, { ...project.workflow.nodes[1], id: 'c', label: '新增步骤' }] } } }));
  await runtime.dispatch('run.review', { runId: run.id, approved: true }); await runtime.waitForIdle();
  const after = (await runtime.dispatch('run.list', { projectId: project.id }) as { items: RunRecord[] }).items[0];
  expect(after).toMatchObject({ id: run.id, status: 'succeeded', workflowVersion: project.workflow.version });
  const activities = await runtime.dispatch('run.activities', { runId: run.id }) as { items: Array<{ nodeId: string }> };
  expect(activities.items.map(item => item.nodeId).sort()).toEqual(['a', 'b']);
  expect((await current()).workflow).toEqual(edited.workflow);
});
