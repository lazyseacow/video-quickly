import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { costTaskDetailSchema, costTaskSchema, projectSchema, recordPageSchema, workflowNodeSchema, type ModelProfile, type RunRecord, type UsageRecord } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';

const directories: string[] = [], servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function open(directory: string, options: Partial<RuntimeOptions> = {}) { const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused', ...options }); runtimes.add(runtime); return runtime; }
async function records(runtime: ReturnType<typeof createRuntime>, runId: string) { return (await runtime.dispatch('cost.list', { runId }) as { items: UsageRecord[] }).items; }

async function fixture(provider: ModelProfile['provider'] = 'openai-compatible', options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-cost-http-')); directories.push(directory);
  const state: { usage: unknown; drop: boolean; hold: boolean; release: () => void; calls: number; body?: Record<string, unknown>; path?: string } = { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 50 } }, drop: false, hold: false, release() {}, calls: 0 };
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    state.calls++; state.body = JSON.parse(body) as Record<string, unknown>; state.path = request.url;
    if (state.drop) { response.destroy(); return; }
    if (state.hold) await new Promise<void>(resolve => { state.release = resolve; response.once('close', resolve); });
    if (response.destroyed) return;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(provider === 'ollama' ? { message: { role: 'assistant', content: '本机模型回复' }, prompt_eval_count: 10, eval_count: 3, prompt_eval_cached_count: 2 } : { choices: [{ message: { content: '真实 HTTP 回复' } }], ...(state.usage !== undefined ? { usage: state.usage } : {}) }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无效测试服务地址');
  const runtime = open(directory, options);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '费用追踪' }));
  const model = await runtime.dispatch('model.save', { model: { name: '费用模型', provider, baseUrl: `http://127.0.0.1:${address.port}${provider === 'ollama' ? '' : '/v1'}`, model: 'metered-model', capabilities: ['text'], parameters: provider === 'ollama' ? { options: { temperature: .3, num_predict: 12 } } : { temperature: .2, private_fixture: 'not-for-the-cost-ledger' }, pricing: { currency: 'USD', inputPerMillionTokens: 2, outputPerMillionTokens: 8 } } }) as ModelProfile;
  await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'metered', version: 1, name: '费用夹具', nodes: [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id })], edges: [] } });
  const start = async () => { const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord; await runtime.waitForIdle(); return run; };
  return { runtime, directory, project, model, state, start };
}

it('records official OpenAI usage counters and freezes pricing without storing model parameters as billing evidence', async () => {
  const { runtime, model, state, start } = await fixture();
  const run = await start(), [record] = await records(runtime, run.id);
  expect(state.calls).toBe(1); expect(state.path).toBe('/v1/chat/completions');
  expect(record).toMatchObject({ status: 'completed', modelId: model.id, operationId: `${run.id}:brief`, requestMetrics: { source: 'request', requestCount: 1 }, providerUsage: { source: 'provider', inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 50 }, estimatedAmount: .00036, estimateBasis: 'provider' });
  expect(record.actualAmount).toBeUndefined(); expect(JSON.stringify(record)).not.toContain('not-for-the-cost-ledger');
  const tasks = recordPageSchema(costTaskSchema).parse(await runtime.dispatch('cost.tasks', { projectId: record.projectId }));
  expect(tasks.items.map(task => task.id)).toEqual([run.id]);
  const detail = costTaskDetailSchema.parse(await runtime.dispatch('cost.task.get', { runId: run.id }));
  expect(detail).toMatchObject({ projectTitle: '费用追踪', title: '简报', status: 'succeeded', summary: { total: 1 } });
  expect(detail.nodes).toEqual([{ id: 'brief', label: '简报' }]);
  await runtime.dispatch('model.save', { model: { ...model, pricing: { currency: 'CNY', inputPerMillionTokens: 100, outputPerMillionTokens: 100 } } });
  expect((await records(runtime, run.id))[0].pricing).toEqual(model.pricing);
  const paid = await runtime.dispatch('cost.update', { id: record.id, revision: record.revision, actualAmount: .01, actualCurrency: 'CNY', note: '人工核对' }) as UsageRecord;
  expect(paid).toMatchObject({ estimatedAmount: .00036, actualAmount: .01, actualCurrency: 'CNY' });
});

it('uses native Ollama options and provider-reported prompt/eval counters', async () => {
  const { runtime, state, start } = await fixture('ollama');
  const run = await start(), [record] = await records(runtime, run.id);
  expect(state.path).toBe('/api/chat'); expect(state.body?.options).toEqual({ temperature: .3, num_predict: 12 }); expect(state.body?.temperature).toBeUndefined();
  expect(record.providerUsage).toMatchObject({ source: 'provider', inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 });
  expect(record.providerUsage?.totalTokens).toBeUndefined(); expect(record.estimatedAmount).toBe(.000044);
});

it.each([undefined, { prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: '20' }])('keeps absent or partial provider usage unknown: %j', async usage => {
  const { runtime, state, start } = await fixture(); state.usage = usage;
  const run = await start(), [record] = await records(runtime, run.id);
  expect(record.status).toBe('completed'); expect(record.estimatedAmount).toBeUndefined(); expect(record.actualAmount).toBeUndefined();
});

it.each(['after-dispatch', 'after-result', 'after-commit'] as const)('keeps one ledger operation across restart after %s without another POST', async point => {
  let crashed = false;
  const { runtime: first, directory, start, state } = await fixture('openai-compatible', { failpoint(current, id) { if (!crashed && current === point && id === 'brief') { crashed = true; throw new SimulatedProcessExit(); } } });
  const run = await start(), [initial] = await records(first, run.id);
  expect(crashed).toBe(true); expect(state.calls).toBe(point === 'after-dispatch' ? 0 : 1);
  expect(initial.status).toBe(point === 'after-dispatch' ? 'submitted' : 'completed');
  await first.close(); runtimes.delete(first);
  const second = open(directory);
  expect((await records(second, run.id))[0].status).toBe(point === 'after-dispatch' ? 'unknown' : 'completed');
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  const restored = await records(second, run.id);
  expect(restored).toHaveLength(1); expect(restored[0].id).toBe(initial.id); expect(state.calls).toBe(point === 'after-dispatch' ? 0 : 1);
});

it('preserves an unknown submission through restart without a second request or a fabricated actual charge', async () => {
  const { runtime: first, directory, state, start } = await fixture(); state.drop = true;
  const run = await start(), [record] = await records(first, run.id);
  expect(record.status).toBe('unknown'); expect(record.estimatedAmount).toBeUndefined(); expect(state.calls).toBe(1);
  await first.close(); runtimes.delete(first);
  const second = open(directory); await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  const [restored] = await records(second, run.id); expect(restored.id).toBe(record.id); expect(restored.status).toBe('unknown'); expect(restored.actualAmount).toBeUndefined(); expect(state.calls).toBe(1);
});

it('keeps legacy injected string providers compatible and leaves token charges unknown', async () => {
  const { runtime, start, state } = await fixture('openai-compatible', { provider: async () => '旧接口文字结果' });
  const run = await start(), [record] = await records(runtime, run.id);
  expect(state.calls).toBe(0); expect(record.status).toBe('completed'); expect(record.providerUsage).toBeUndefined(); expect(record.estimatedAmount).toBeUndefined();
});

it('marks a canceled in-flight HTTP request without claiming a paid amount', async () => {
  const { runtime, project, state } = await fixture(); state.hold = true;
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord;
  await vi.waitFor(() => expect(state.calls).toBe(1));
  expect((await records(runtime, run.id))[0].status).toBe('submitted');
  await runtime.dispatch('run.cancel', { runId: run.id }); await runtime.waitForIdle(); state.release();
  const [record] = await records(runtime, run.id); expect(record.status).toBe('canceled'); expect(record.actualAmount).toBeUndefined(); expect(record.estimatedAmount).toBeUndefined();
});
