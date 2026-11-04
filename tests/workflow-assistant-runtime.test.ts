import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { costSummarySchema, modelSchema, productionQueueEnqueueResultSchema, projectSchema, runInspectionSchema, runSummarySchema, workflowProposalSchema, workSchema, type ProjectDocument } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src/index';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

const runtimes: ReturnType<typeof createRuntime>[] = [], directories: string[] = [], releases: Array<() => void> = [];
afterEach(async () => { releases.splice(0).forEach(release => release()); await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-workflow-assistant-')); directories.push(directory);
  const prompts: string[] = [];
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider: async request => { prompts.push(request.prompt); return { text: JSON.stringify({ summary: '增加镜头节奏', patch: { prompt: '缓慢推近木盒，保持人物动作连续。' } }), usage: { source: 'provider', inputTokens: 37, outputTokens: 19 } }; }, ...extra };
  const runtime = createRuntime(options); runtimes.push(runtime);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '建议文本', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', connectionType: 'text', capabilities: ['text'], model: 'fixture' } }));
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '可审阅修改', brief: '寻找木盒' }));
  const node = project.workflow.nodes.find(node => node.kind === 'brief')!;
  const input = { projectId: project.id, revision: project.revision, node, modelId: model.id, instruction: '强调人物动作与节奏', requestId: randomUUID() };
  return { runtime, options, directory, prompts, model, project, node, input, current: async () => (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project };
}
function started(value: unknown) { if (!value || typeof value !== 'object' || !('run' in value) || !('nodeId' in value) || typeof value.nodeId !== 'string') throw new Error('启动响应格式'); return { run: runSummarySchema.parse(value.run), nodeId: value.nodeId }; }
async function reopen(source: Awaited<ReturnType<typeof fixture>>) {
  await source.runtime.close(); runtimes.splice(runtimes.indexOf(source.runtime), 1);
  const runtime = createRuntime({ ...source.options, failpoint: undefined }); runtimes.push(runtime); return runtime;
}
it('persists one suggestion per request identity, retains frozen input and costs, and never writes project content', async () => {
  const source = await fixture();
  expect(await source.runtime.dispatch('workflowAssistant.latest', { projectId: source.project.id, nodeId: source.node.id })).toBeNull();
  const first = started(await source.runtime.dispatch('workflowAssistant.start', source.input)); await source.runtime.waitForIdle();
  const repeated = started(await source.runtime.dispatch('workflowAssistant.start', source.input));
  expect(repeated.run.id).toBe(first.run.id); expect(repeated.run.status, repeated.run.error).toBe('succeeded'); expect(repeated.run.purpose).toBe('workflow-assistant');
  expect(source.prompts).toHaveLength(1); expect(await source.current()).toEqual(source.project);
  const result = await source.runtime.dispatch('node.result', { runId: first.run.id, nodeId: first.nodeId }) as { proposal: unknown; text: string };
  const proposal = workflowProposalSchema.parse(result.proposal); expect(proposal.baseline).toEqual(source.node); expect(proposal.projectRevision).toBe(source.project.revision);
  expect(await source.runtime.dispatch('workflowAssistant.latest', { projectId: source.project.id, nodeId: source.node.id })).toMatchObject({ run: { id: first.run.id }, nodeId: first.nodeId, modelId: source.model.id, context: { projectId: source.project.id, baseline: JSON.parse(JSON.stringify(source.node)), instruction: source.input.instruction } });
  expect(result.text).toContain('缓慢推近');
  expect(costSummarySchema.parse(await source.runtime.dispatch('cost.summary', { runId: first.run.id }))).toMatchObject({ total: 1, tokens: { inputTokens: 37, outputTokens: 19 } });
  const detail = await source.runtime.dispatch('project.get', { projectId: source.project.id }) as { latestRun?: unknown }; expect(detail.latestRun).toBeUndefined();
  expect(await source.runtime.dispatch('run.list', { projectId: source.project.id, purpose: 'production' })).toMatchObject({ items: [] });
  expect(await source.runtime.dispatch('run.list', { projectId: source.project.id, purpose: 'workflow-assistant' })).toMatchObject({ items: [{ id: first.run.id }] });
  await expect(source.runtime.dispatch('workflowAssistant.start', { ...source.input, instruction: '其他要求' })).rejects.toThrow('其他输入');
  await expect(source.runtime.dispatch('node.apply', { runId: first.run.id, nodeId: first.nodeId, revision: source.project.revision })).rejects.toThrow('编辑草稿');
  await expect(source.runtime.dispatch('run.start', { projectId: source.project.id, parentRunId: first.run.id })).rejects.toThrow();
  expect(await source.runtime.dispatch('run.replay', { runId: first.run.id })).toMatchObject({ externalCalls: 0, matchesSnapshot: true }); expect(source.prompts).toHaveLength(1);
});
it('preserves invalid suggestion text and provider usage as a completed receipt without resubmitting', async () => {
  let calls = 0;
  const text = JSON.stringify({ summary: '越权修改', patch: { config: { operation: 'regenerate' } } });
  const source = await fixture({ provider: async () => { calls++; return { text, usage: { source: 'provider', inputTokens: 5, outputTokens: 6 } }; } });
  const first = started(await source.runtime.dispatch('workflowAssistant.start', source.input)); await source.runtime.waitForIdle();
  const result = await source.runtime.dispatch('node.result', { runId: first.run.id, nodeId: first.nodeId }) as { text: string; proposalError: string; proposal?: unknown };
  expect(result.text).toBe(text); expect(result.proposalError).toBeTruthy(); expect(result.proposal).toBeUndefined();
  expect(runInspectionSchema.parse(await source.runtime.dispatch('run.inspect', { runId: first.run.id })).steps.some(step => step.unknownSubmission)).toBe(false);
  const database = openDatabase(source.directory);
  try { expect(new DocumentStore(database).get('node-result', `${first.run.id}:${first.nodeId}`)).toMatchObject({ text, proposalError: expect.any(String) }); expect(database.prepare('SELECT status FROM activities WHERE run_id = ?').get(first.run.id)).toEqual({ status: 'completed' }); } finally { database.close(); }
  const runtime = await reopen(source); const repeated = started(await runtime.dispatch('workflowAssistant.start', source.input));
  expect(repeated.run.id).toBe(first.run.id); expect(calls).toBe(1);
  expect(await runtime.dispatch('workflowAssistant.latest', { projectId: source.project.id, nodeId: source.node.id })).toMatchObject({ run: { id: first.run.id }, context: { baseline: JSON.parse(JSON.stringify(source.node)) } });
  expect(costSummarySchema.parse(await runtime.dispatch('cost.summary', { runId: first.run.id }))).toMatchObject({ total: 1, tokens: { inputTokens: 5, outputTokens: 6 } });
  expect((await runtime.dispatch('project.get', { projectId: source.project.id }) as { project: ProjectDocument }).project).toEqual(source.project);
});
it('recovers a committed suggestion after an interruption without another provider request', async () => {
  let interrupted = false;
  const source = await fixture({ failpoint(point) { if (!interrupted && point === 'after-commit') { interrupted = true; throw new SimulatedProcessExit(); } } });
  const first = started(await source.runtime.dispatch('workflowAssistant.start', source.input)); await source.runtime.waitForIdle();
  const runtime = await reopen(source);
  await runtime.dispatch('run.resume', { runId: first.run.id }); await runtime.waitForIdle();
  expect(runSummarySchema.parse(await runtime.dispatch('run.get', { runId: first.run.id })).status).toBe('succeeded'); expect(source.prompts).toHaveLength(1);
  expect(await runtime.dispatch('node.result', { runId: first.run.id, nodeId: first.nodeId })).toMatchObject({ proposal: { patch: { prompt: '缓慢推近木盒，保持人物动作连续。' } } });
});
it('keeps an ambiguous submission blocked after restart and cancellation explicit', async () => {
  let interrupted = false;
  const source = await fixture({ failpoint(point) { if (!interrupted && point === 'after-result') { interrupted = true; throw new SimulatedProcessExit(); } } });
  const first = started(await source.runtime.dispatch('workflowAssistant.start', source.input)); await source.runtime.waitForIdle();
  const runtime = await reopen(source);
  await runtime.dispatch('run.resume', { runId: first.run.id }); await runtime.waitForIdle();
  expect(source.prompts).toHaveLength(1);
  expect(runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: first.run.id })).steps.some(step => step.unknownSubmission)).toBe(true);
  await runtime.dispatch('run.cancel', { runId: first.run.id });
  expect(runSummarySchema.parse(await runtime.dispatch('run.get', { runId: first.run.id })).status).toBe('canceled');
  await expect(runtime.dispatch('run.start', { projectId: source.project.id, parentRunId: first.run.id })).rejects.toThrow();
});
it('stops an in-flight suggestion and protects revisions and production-queue reservations', async () => {
  let submitted = false;
  const source = await fixture({ provider: async request => { submitted = true; await new Promise<void>((resolve, reject) => { releases.push(resolve); request.signal?.addEventListener('abort', () => reject(new Error('停止')), { once: true }); }); return '未使用'; } });
  const first = started(await source.runtime.dispatch('workflowAssistant.start', source.input)); await expect.poll(() => submitted).toBe(true);
  await source.runtime.dispatch('run.cancel', { runId: first.run.id }); await source.runtime.waitForIdle();
  expect(runSummarySchema.parse(await source.runtime.dispatch('run.get', { runId: first.run.id })).status).toBe('canceled'); expect(await source.current()).toEqual(source.project);
  const work = workSchema.parse(await source.runtime.dispatch('work.save', { title: '队列占用作品', defaults: {} }));
  const attached = projectSchema.parse(await source.runtime.dispatch('work.episode.attach', { workId: work.id, workRevision: work.revision, projectId: source.project.id, revision: source.project.revision, number: 1 }));
  await expect(source.runtime.dispatch('workflowAssistant.start', { ...source.input, requestId: randomUUID() })).rejects.toThrow('其他视图修改');
  const queue = productionQueueEnqueueResultSchema.parse(await source.runtime.dispatch('productionQueue.enqueue', { workId: work.id, workRevision: work.revision, requestId: randomUUID(), projects: [{ projectId: attached.id, revision: attached.revision }] })); expect(queue.items).toHaveLength(1);
  await expect(source.runtime.dispatch('workflowAssistant.start', { ...source.input, revision: attached.revision, requestId: randomUUID() })).rejects.toThrow('未完成');
});
