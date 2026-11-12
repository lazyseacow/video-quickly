import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runInspectionSchema, runSchema, runStepPayloadSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../src/packages/runtime/src';
import { DocumentStore, openDatabase } from '../src/packages/runtime/src/database';
import { ModelResponseValidationError } from '../src/packages/runtime/src/model-responses';
import { parseWorkflowScript } from '../src/packages/runtime/src/workflow-prompts';
import { TextRequestRejectedError, type TextGenerationRequest } from '../src/packages/runtime/src/providers';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const valid = JSON.stringify({ shots: [{ title: '新镜头', narration: '实际旁白', visualPrompt: '手绘办公桌', durationUs: 2_000_000 }], entities: [] });
const invalid = JSON.stringify({ shots: [{ title: '保留原文', narration: { text: '不要写入错误信息的原文' }, visualPrompt: 'api_key=fixture-private-value', durationUs: '2 秒' }] });
async function fixture(response: (request: TextGenerationRequest) => ReturnType<NonNullable<RuntimeOptions['provider']>>, extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-script-validation-')); directories.push(directory);
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async request => request.prompt.includes('自动视频制作步骤：简报') ? '本次已完成的简报' : request.prompt.includes('自动视频制作步骤：风格') ? '本次已完成的风格' : response(request));
  const tail = vi.fn<NonNullable<RuntimeOptions['executeActivity']>>(async () => ({ assets: [] }));
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider, executeActivity: tail, ...extra };
  const runtime = createRuntime(options); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '分镜校验', brief: '开始前的输入' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '固定文本', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  const nodes = ['brief', 'style', 'script', 'assets'].map(kind => workflowNodeSchema.parse({ id: kind, kind, label: ({ brief: '简报', style: '风格', script: '旁白与分镜', assets: '后续素材' } as Record<string, string>)[kind], modelId: kind === 'assets' ? undefined : model.id }));
  await runtime.dispatch('project.update', { projectId: project.id, patch: { workflow: { id: 'script-validation', name: '校验', version: 1, production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: nodes[i].id, target: node.id })) } } });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  const inspect = () => runtime.dispatch('run.inspect', { runId: run.id }).then(value => runInspectionSchema.parse(value));
  const output = () => runtime.dispatch('run.step.payload', { runId: run.id, nodeId: 'script', kind: 'output' }).then(value => runStepPayloadSchema.parse(value));
  return { runtime, options, directory, provider, tail, run, inspect, output };
}

it('reports safe field paths for schema and reference errors without echoing response values', () => {
  let caught: unknown;
  try { parseWorkflowScript(invalid, { shots: [] }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ModelResponseValidationError);
  expect(caught).toMatchObject({ issues: [{ path: 'shots[0].narration', message: '应为字符串' }, { path: 'shots[0].durationUs', message: '应为数字' }] });
  expect(String(caught)).not.toContain('不要写入'); expect(String(caught)).not.toContain('fixture-private-value');
  expect(() => parseWorkflowScript('{"shots":[', { shots: [] })).toThrow('不是有效 JSON');
  expect(() => parseWorkflowScript(JSON.stringify({ title: '只返回一个镜头', narration: '', visualPrompt: '' }), { shots: [] })).toThrow('顶层必须是');
  expect(() => parseWorkflowScript(JSON.stringify({ shots: [{ title: '镜头', narration: '', visualPrompt: '', characterKeys: ['private-role-key'] }] }), { shots: [] })).toThrow('shots[0].characterKeys[0]');
});

it('saves invalid raw text, exposes exact redacted errors, and retries only script with frozen upstream outputs', async () => {
  let response = invalid;
  const f = await fixture(async () => ({ text: response, usage: { source: 'provider', inputTokens: 20, outputTokens: 30 } }));
  const before = await f.inspect(), failed = before.steps.find(step => step.id === 'script');
  expect(before.run.status).toBe('failed'); expect(failed).toMatchObject({ status: 'failed', unknownSubmission: false, outputAvailable: false, responseAvailable: true, retry: { allowed: true } });
  expect(failed?.error).toContain('shots[0].narration'); expect(failed?.error).not.toContain('外部调用');
  const output = await f.output(); expect(output.available).toBe(false);
  expect(output.modelResponse).toMatchObject({ attempt: 1, issues: [{ path: 'shots[0].narration' }, { path: 'shots[0].durationUs' }] });
  expect(output.modelResponse?.text).toContain('保留原文'); expect(output.modelResponse?.text).not.toContain('fixture-private-value');
  const db = openDatabase(f.directory), store = new DocumentStore(db);
  const upstream = ['brief', 'style'].map(id => store.get('node-result', `${f.run.id}:${id}`));
  expect(store.get<{ response: { text: string } }>('model-response', `${f.run.id}:script:1`)?.response.text).toBe(invalid);
  await f.runtime.dispatch('run.resume', { runId: f.run.id }); await f.runtime.waitForIdle();
  expect(f.provider).toHaveBeenCalledTimes(3); // A resume revalidates the saved text.
  response = valid;
  await f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'script' }); await f.runtime.waitForIdle();
  const after = await f.inspect();
  expect(after.run).toMatchObject({ id: f.run.id, snapshotDigest: before.run.snapshotDigest, status: 'needs_attention', stepRetry: { nodeId: 'script', status: 'completed' } });
  expect(after.steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['assets', 'pending']]);
  expect(f.provider).toHaveBeenCalledTimes(4); expect(f.tail).not.toHaveBeenCalled();
  expect(f.provider.mock.calls[3][0]).toMatchObject({ outputSchema: { type: 'object' } });
  const request = f.provider.mock.calls[3][0];
  for (const content of ['本次已完成的简报', '本次已完成的风格', 'shots[0].narration', '上次分镜返回的字段校验错误', 'durationUs 填写不小于 4000000']) expect(request.prompt).toContain(content);
  expect(request.operationId).not.toBe(f.provider.mock.calls[2][0].operationId);
  expect(['brief', 'style'].map(id => store.get('node-result', `${f.run.id}:${id}`))).toEqual(upstream);
  expect(store.get('model-response', `${f.run.id}:script:1`)).toBeDefined(); expect((await f.output()).modelResponse).toMatchObject({ attempt: 2, text: valid });
  expect((await f.output()).modelResponseHistory).toMatchObject([{ attempt: 2, invalid: false }, { attempt: 1, invalid: true }]);
  const previous = runStepPayloadSchema.parse(await f.runtime.dispatch('run.step.payload', { runId: f.run.id, nodeId: 'script', kind: 'output', responseAttempt: 1 }));
  expect(previous.modelResponse).toMatchObject({ attempt: 1, issues: [{ path: 'shots[0].narration' }, { path: 'shots[0].durationUs' }] });
  expect(previous.modelResponse?.text).not.toContain('fixture-private-value');
  expect(db.prepare("SELECT count(*) AS n FROM documents WHERE kind = 'usage-record' AND json_extract(body, '$.nodeId') = 'script'").get()).toEqual({ n: 2 });
  db.close();
  const logs = await readFile(join(f.directory, 'logs', 'runtime.log'), 'utf8');
  expect(logs).not.toContain('fixture-private-value'); expect(logs).not.toContain('不要写入错误信息');
});

it('keeps unresolved text submissions unknown and blocks both retry and duplicate resume requests', async () => {
  const f = await fixture(async () => { throw new Error('transport disconnected'); });
  const failed = (await f.inspect()).steps.find(step => step.id === 'script');
  expect(failed).toMatchObject({ status: 'failed', unknownSubmission: true, retry: { allowed: false } });
  await expect(f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'script' })).rejects.toThrow('核对');
  await f.runtime.dispatch('run.resume', { runId: f.run.id }); await f.runtime.waitForIdle();
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.tail).not.toHaveBeenCalled();
});

it('preserves confirmed HTTP rejections across restart and permits only an explicit single-step retry', async () => {
  let rejected = true;
  const f = await fixture(async () => { if (rejected) throw new TextRequestRejectedError(400); return valid; });
  const failed = (await f.inspect()).steps.find(step => step.id === 'script');
  expect(failed).toMatchObject({ unknownSubmission: false, retry: { allowed: true }, error: expect.stringContaining('HTTP 400') });
  expect((await f.output()).available).toBe(false);
  await f.runtime.close();
  const recovered = createRuntime(f.options); runtimes.push(recovered);
  await recovered.dispatch('run.resume', { runId: f.run.id }); await recovered.waitForIdle();
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.tail).not.toHaveBeenCalled();
  rejected = false;
  await recovered.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'script' }); await recovered.waitForIdle();
  const inspection = runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: f.run.id }));
  expect(inspection.steps.map(step => [step.id, step.status])).toEqual([['brief', 'succeeded'], ['style', 'succeeded'], ['script', 'succeeded'], ['assets', 'pending']]);
  expect(f.provider).toHaveBeenCalledTimes(4); expect(f.tail).not.toHaveBeenCalled();
  const db = openDatabase(f.directory), store = new DocumentStore(db);
  try {
    expect(store.get('model-response', `${f.run.id}:script:1`)).toMatchObject({ status: 'rejected', rejection: { status: 400 } });
    expect(store.list<{ nodeId: string; status: string }>('usage-record').filter(item => item.nodeId === 'script').map(item => item.status)).toEqual(['failed', 'completed']);
  } finally { db.close(); }
});

it('keeps prior field corrections when a later request is explicitly rejected', async () => {
  let scripts = 0;
  const f = await fixture(async () => { scripts++; if (scripts === 1) return invalid; if (scripts === 2) throw new TextRequestRejectedError(400, true); return valid; });
  await f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'script' }); await f.runtime.waitForIdle();
  expect((await f.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ unknownSubmission: false, retry: { allowed: true } });
  await f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'script' }); await f.runtime.waitForIdle();
  expect(f.provider).toHaveBeenCalledTimes(5); expect(f.tail).not.toHaveBeenCalled();
  expect(f.provider.mock.calls[4][0].prompt).toContain('shots[0].narration');
  expect((await f.output()).modelResponseHistory?.map(item => item.attempt)).toEqual([3, 1]);
});

it('persists a negotiated prompt format for the same frozen step across explicit retries', async () => {
  let first = true;
  const f = await fixture(async request => { if (first) request.onOutputFormatFallback?.(); return first ? invalid : valid; });
  first = false;
  await f.runtime.dispatch('run.step.retry', { runId: f.run.id, nodeId: 'script' }); await f.runtime.waitForIdle();
  expect(f.provider.mock.calls[3][0].promptOutputFormat).toBe(true);
  expect(f.provider.mock.calls[3][0].model).toEqual(f.provider.mock.calls[2][0].model);
  expect(f.tail).not.toHaveBeenCalled();
});

it.each([
  { reason: 'max_output_tokens', message: '已达到 Token 上限' },
  { reason: undefined, message: '具体原因未知' },
] as const)('preserves incomplete raw output with reason $reason even when its JSON parses', async ({ reason, message }) => {
  const f = await fixture(async () => ({ text: valid, incomplete: true, incompleteReason: reason }));
  expect((await f.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ unknownSubmission: false, retry: { allowed: true } });
  expect((await f.output()).modelResponse).toMatchObject({ text: valid, incomplete: true, issues: [{ path: '$', message: expect.stringContaining(message) }] });
  expect(f.tail).not.toHaveBeenCalled();
});

it('reuses received raw text after a process exit between response persistence and activity commit', async () => {
  let crashed = false;
  const f = await fixture(async () => valid, { failpoint(point, activityId) { if (!crashed && point === 'after-result' && activityId === 'script') { crashed = true; throw new SimulatedProcessExit(); } } });
  expect(crashed).toBe(true); expect(f.provider).toHaveBeenCalledTimes(3);
  await f.runtime.close();
  const recovered = createRuntime({ ...f.options, failpoint: undefined }); runtimes.push(recovered);
  const inspect = runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: f.run.id }));
  expect(inspect.recovery.resume).toBe(true);
  await recovered.dispatch('run.resume', { runId: f.run.id }); await recovered.waitForIdle();
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.tail).toHaveBeenCalledTimes(1);
  expect(runInspectionSchema.parse(await recovered.dispatch('run.inspect', { runId: f.run.id })).run.status).toBe('succeeded');
});
