import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, runSchema, workflowNodeSchema, type JsonValue } from '@video-quickly/contracts';
import { createRuntime } from '../src/index.js';

const directories: string[] = [], servers: Server[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

for (const annotations of ['missing', 'null', 'present'] as const) it(`continues Responses tool calls with ${annotations} text annotations and preserves raw usage counters`, async () => {
  let calls = 0, sawToolOutput = false;
  const requests: Array<{ url?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ url: request.url, body }); calls++;
    sawToolOutput ||= Array.isArray(body.input) && body.input.some(item => item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output');
    const text = { type: 'output_text', text: calls === 1 ? '读取实际项目。' : '已读取项目并完成本次任务。', ...(annotations === 'missing' ? {} : { annotations: annotations === 'null' ? null : [] }) };
    const payload = JSON.stringify({ id: `resp_${calls}`, object: 'response', created_at: 1, status: 'completed', model: 'fixture',
      output: [{ id: `msg_${calls}`, type: 'message', role: 'assistant', status: 'completed', content: [text] },
        ...(calls === 1 ? [{ id: 'fc_1', type: 'function_call', call_id: 'call_project', name: 'read_project_snapshot', arguments: '{}', status: 'completed' }] : [])],
      usage: calls === 1 ? { input_tokens: 0, output_tokens: 2, total_tokens: 2 } : { output_tokens: 0 },
    });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-request-id': `fixture-${calls}` }); response.end(payload);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  const directory = await mkdtemp(join(tmpdir(), 'vq-agent-responses-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); runtimes.push(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: 'Responses 实际工具循环' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'Responses fixture', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', textProtocol: 'responses', connectionType: 'text', capabilities: ['text', 'tools'] } }));
  await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: { ...created.workflow, id: 'responses-agent', nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Responses Agent', modelId: model.id, prompt: '读取项目并返回实际结果。' })], edges: [] } } });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: created.id })); await runtime.waitForIdle();
  const completed = runSchema.parse(await runtime.dispatch('run.get', { runId: run.id }));
  expect(completed.status, completed.error).toBe('succeeded'); expect(calls).toBe(2); expect(sawToolOutput).toBe(true);
  expect(requests.map(request => request.url)).toEqual(['/v1/responses', '/v1/responses']);
  expect(requests.every(request => request.body.store === false)).toBe(true);
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'agent' })).toMatchObject({ text: '已读取项目并完成本次任务。' });
  const costs = await runtime.dispatch('cost.list', { runId: run.id }) as { items: Array<{ providerUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }> };
  expect(costs.items).toHaveLength(2);
  expect(costs.items.map(item => item.providerUsage)).toContainEqual({ source: 'provider', inputTokens: 0, outputTokens: 2, totalTokens: 2 });
  expect(costs.items.map(item => item.providerUsage)).toContainEqual({ source: 'provider', outputTokens: 0 });
  const replay = await runtime.dispatch('run.replay', { runId: run.id }) as { outputs: Record<string, JsonValue>; matchesSnapshot: boolean; externalCalls: number };
  expect(replay).toMatchObject({ matchesSnapshot: true, externalCalls: 0 }); expect(calls).toBe(2);
});
