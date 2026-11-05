import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runInspectionSchema, runSchema, workflowNodeSchema, type ProjectDocument, type WorkflowTemplate } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(extra: Partial<RuntimeOptions> = {}, final = false, nested = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-step-retry-')); directories.push(directory);
  let failures = 1;
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async () => provider.mock.calls.length === 1 ? '本次生成的简报' : '本次生成的风格');
  const media = vi.fn<NonNullable<RuntimeOptions['executeActivity']>>(async context => {
    if (context.node.kind === 'assets' && failures-- > 0) throw new Error('controlled media failure');
    return context.node.kind === 'assets' ? { assets: [], source: 'fixture' } : { completed: true };
  });
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider, executeActivity: media, ...extra };
  const runtime = createRuntime(options); runtimes.push(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '单步骤重试', brief: '初始简报' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '冻结文本连接', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  const nodes = [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id }), workflowNodeSchema.parse({ id: 'style', kind: 'style', label: '风格', modelId: model.id }), workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '素材' }), ...(!final ? [workflowNodeSchema.parse({ id: 'export', kind: 'export', label: '导出' })] : [])];
  const production = { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' };
  const template = nested ? await runtime.dispatch('workflowTemplate.save', { name: '重试子流程', workflow: { id: 'nested', name: 'nested', version: 1, production, nodes: [nodes[2], workflowNodeSchema.parse({ id: 'tail', kind: 'animation', label: '子流程后续', config: { operation: 'prepare-edit' } })], edges: [{ id: 'next', source: 'assets', target: 'tail' }] } }) as WorkflowTemplate : undefined;
  if (template) nodes[2] = workflowNodeSchema.parse({ id: 'call', kind: 'subflow', label: '子流程', subflow: { id: template.id, version: 1, inputs: {} } });
  const project = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: created.id, workflow: { id: 'retry-flow', version: 1, name: '重试验收', production, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id })), ...(template ? { subflows: [template.definition] } : {}) } }));
  const started = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  return { runtime, directory, options, project, model, run: started, provider, media, fail: (count = 1) => { failures = count; } };
}
const inspect = async (runtime: ReturnType<typeof createRuntime>, runId: string) => runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId }));
const retry = async (runtime: ReturnType<typeof createRuntime>, runId: string, nodeId = 'assets') => { const result = runSchema.parse(await runtime.dispatch('run.step.retry', { runId, nodeId })); await runtime.waitForIdle(); return result; };
const current = async (runtime: ReturnType<typeof createRuntime>, projectId: string) => (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project;

it('retries only the selected failed step in the original run with its frozen upstream outputs and inputs', async () => {
  const f = await fixture();
  const before = await inspect(f.runtime, f.run.id);
  expect(before.steps.find(step => step.id === 'assets')?.retry).toEqual({ allowed: true, reason: '' });
  const edited = projectSchema.parse(await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { brief: '后来修改的简报', style: '后来修改的风格', workflow: { ...f.project.workflow, nodes: f.project.workflow.nodes.filter(node => node.id !== 'assets'), edges: [] } } }));
  await retry(f.runtime, f.run.id);
  const detail = await inspect(f.runtime, f.run.id);
  expect(detail.run).toMatchObject({ id: f.run.id, snapshotDigest: before.run.snapshotDigest, status: 'needs_attention', stepRetry: { nodeId: 'assets', status: 'completed' } });
  expect(detail.run.currentNodeId).toBeUndefined(); expect(detail.run.error).toBeUndefined();
  expect(detail.steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['assets', 'succeeded'], ['export', 'pending']]);
  expect(detail.recovery.resume).toBe(true); expect(detail.recovery.reason).toContain('后续步骤尚未执行');
  expect(f.provider).toHaveBeenCalledTimes(2); expect(f.media.mock.calls.map(([context]) => context.node.id)).toEqual(['assets', 'assets']);
  const context = f.media.mock.calls[1][0];
  expect(context.project).toMatchObject({ brief: '本次生成的简报', style: '本次生成的风格' });
  expect(context.promptUpstream).toMatchObject({ brief: { text: '本次生成的简报' }, style: { text: '本次生成的风格' } });
  expect(context.operationId).toBe(f.media.mock.calls[0][0].operationId);
  expect(await current(f.runtime, f.project.id)).toEqual(edited);
  expect((await f.runtime.dispatch('run.list', { projectId: f.project.id }) as { items: unknown[] }).items).toHaveLength(1);
  await f.runtime.dispatch('run.resume', { runId: f.run.id }); await f.runtime.waitForIdle();
  expect((await inspect(f.runtime, f.run.id)).run.status).toBe('succeeded');
  expect(f.media.mock.calls.map(([context]) => context.node.id)).toEqual(['assets', 'assets', 'export']); expect(f.provider).toHaveBeenCalledTimes(2);
  expect(await current(f.runtime, f.project.id)).toEqual(edited);
});

it('keeps a failed retry limited to that step and permits another manual retry', async () => {
  const f = await fixture(); f.fail();
  await retry(f.runtime, f.run.id);
  expect((await inspect(f.runtime, f.run.id)).run.status).toBe('failed');
  await retry(f.runtime, f.run.id);
  expect((await inspect(f.runtime, f.run.id)).steps.find(step => step.id === 'assets')?.status).toBe('succeeded');
  expect(f.media.mock.calls.map(([context]) => context.node.id)).toEqual(['assets', 'assets', 'assets']); expect(f.provider).toHaveBeenCalledTimes(2);
});

it('retries a failed subflow child without running its siblings or the parent downstream', async () => {
  const f = await fixture({}, false, true), nodeId = 'call/subflow/assets';
  expect((await inspect(f.runtime, f.run.id)).steps.find(step => step.id === nodeId)?.retry?.allowed).toBe(true);
  await retry(f.runtime, f.run.id, nodeId);
  const detail = await inspect(f.runtime, f.run.id);
  expect(detail.run.status).toBe('needs_attention');
  expect(detail.steps.find(step => step.id === nodeId)?.status).toBe('succeeded');
  expect(detail.steps.find(step => step.id === 'call/subflow/tail')?.status).toBe('pending');
  expect(detail.steps.find(step => step.id === 'export')?.status).toBe('pending');
  expect(f.media.mock.calls.map(([context]) => context.node.id)).toEqual([nodeId, nodeId]); expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.media.mock.calls[1][0].promptUpstream).toMatchObject({ brief: { text: '本次生成的简报' }, style: { text: '本次生成的风格' } });
  await f.runtime.dispatch('run.resume', { runId: f.run.id }); await f.runtime.waitForIdle();
  expect((await inspect(f.runtime, f.run.id)).run.status).toBe('succeeded');
  expect(f.media.mock.calls.map(([context]) => context.node.id)).toEqual([nodeId, nodeId, 'call/subflow/tail', 'export']);
});

it('finishes and applies the production when the retried step is the last remaining task', async () => {
  const f = await fixture({}, true); await retry(f.runtime, f.run.id);
  const detail = await inspect(f.runtime, f.run.id);
  expect(detail.run.status).toBe('succeeded'); expect(detail.run.stepRetry).toBeUndefined();
  expect((await current(f.runtime, f.project.id)).style).toBe('本次生成的风格'); expect(f.provider).toHaveBeenCalledTimes(2);
});

it('rejects completed, pending, unknown and unrelated node identities without executing anything', async () => {
  const f = await fixture();
  for (const nodeId of ['brief', 'export', 'missing']) await expect(retry(f.runtime, f.run.id, nodeId)).rejects.toThrow();
  expect(f.media).toHaveBeenCalledTimes(1); expect(f.provider).toHaveBeenCalledTimes(2);
  await f.runtime.dispatch('run.cancel', { runId: f.run.id });
  await expect(retry(f.runtime, f.run.id)).rejects.toThrow(); expect(f.media).toHaveBeenCalledTimes(1);
});

it('deduplicates simultaneous retry requests and rejects retrying an active step', async () => {
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const f = await fixture({ executeActivity: async () => { if (++calls === 1) throw new Error('controlled failure'); entered(); await gate; return { assets: [] }; } });
  try {
    const results = await Promise.allSettled([f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'assets' }), f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'assets' })]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true); await started;
    expect((await inspect(f.runtime, f.run.id)).steps.find(step => step.id === 'assets')?.retry).toBeUndefined();
    expect(calls).toBe(2);
  } finally { release(); await f.runtime.waitForIdle(); }
  expect((await inspect(f.runtime, f.run.id)).run.status).toBe('needs_attention');
});

it('preserves the single-step retry scope after a crash and reuses the committed result', async () => {
  let armed = false, exited = false;
  const f = await fixture({ failpoint(point, activityId) { if (armed && !exited && point === 'after-commit' && activityId === 'assets') { exited = true; throw new SimulatedProcessExit(); } } });
  armed = true; await retry(f.runtime, f.run.id); expect(exited).toBe(true); await f.runtime.close();
  const recovered = createRuntime({ ...f.options, failpoint: undefined }); runtimes.push(recovered);
  await recovered.dispatch('run.resume', { runId: f.run.id }); await recovered.waitForIdle();
  const detail = await inspect(recovered, f.run.id);
  expect(detail.run.status).toBe('needs_attention'); expect(detail.steps.find(step => step.id === 'assets')?.status).toBe('succeeded');
  expect(detail.steps.find(step => step.id === 'export')?.status).toBe('pending');
  expect(f.media.mock.calls.map(([context]) => context.node.id)).toEqual(['assets', 'assets']); expect(f.provider).toHaveBeenCalledTimes(2);
  await recovered.dispatch('run.resume', { runId: f.run.id }); await recovered.waitForIdle();
  expect((await inspect(recovered, f.run.id)).run.status).toBe('succeeded'); expect(f.media).toHaveBeenCalledTimes(3);
});

it('keeps cancellation terminal while a single-step retry is in flight', async () => {
  let release = () => {}, entered = () => {}, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ executeActivity: async () => { if (++calls === 1) throw new Error('controlled failure'); entered(); await gate; return { assets: [] }; } });
  try {
    await f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'assets' }); await started;
    await f.runtime.dispatch('run.cancel', { runId: f.run.id });
  } finally { release(); await f.runtime.waitForIdle(); }
  expect((await inspect(f.runtime, f.run.id)).run.status).toBe('canceled'); expect(calls).toBe(2); expect(f.provider).toHaveBeenCalledTimes(2);
});

it('blocks an ambiguous external submission and never submits it again through step retry', async () => {
  const f = await fixture({ activitySafety: () => 'external' });
  const step = (await inspect(f.runtime, f.run.id)).steps.find(step => step.id === 'assets');
  expect(step?.unknownSubmission).toBe(true); expect(step?.retry).toMatchObject({ allowed: false });
  await expect(retry(f.runtime, f.run.id)).rejects.toThrow('核对'); expect(f.media).toHaveBeenCalledTimes(1);
});

it('rejects missing checkpoints without inventing upstream completion', async () => {
  const f = await fixture(), db = openDatabase(f.directory);
  db.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(f.run.id); db.close();
  await expect(retry(f.runtime, f.run.id)).rejects.toThrow(); expect(f.media).toHaveBeenCalledTimes(1);
});

it('rejects a retry while another run owns the project', async () => {
  const f = await fixture();
  const db = openDatabase(f.directory), store = new DocumentStore(db);
  store.put('run', 'other-active-run', { ...f.run, id: 'other-active-run', status: 'running' }); db.close();
  await expect(retry(f.runtime, f.run.id)).rejects.toThrow('未完成'); expect(f.media).toHaveBeenCalledTimes(1);
});
