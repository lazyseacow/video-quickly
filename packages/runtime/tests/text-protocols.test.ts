import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, workflowNodeSchema, type ModelProfile, type RunRecord, type TextProtocol, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { generateText, testModelConnection, textRequestParameters } from '../src/providers.js';
import { createRuntime } from '../src/index.js';

const servers: Server[] = [], directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function service(handler: (path: string, body: Record<string, unknown>, headers: IncomingHttpHeaders) => unknown) {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(handler(request.url ?? '', body ? JSON.parse(body) : {}, request.headers)));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  return `http://127.0.0.1:${address.port}/gateway/v1`;
}
function model(baseUrl: string, textProtocol?: TextProtocol): ModelProfile {
  return modelSchema.parse({ id: 'model', name: '协议夹具', provider: 'openai-compatible', textProtocol, baseUrl, model: 'fixture', capabilities: ['text', 'image'], parameters: { temperature: .3, max_tokens: 128, size: '1024x1024' }, createdAt: '', updatedAt: '' });
}
const openaiUsage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } };
const anthropicUsage = { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 };

for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  it(`sends and parses real ${protocol} HTTP requests, parameters, authentication, connection checks and usage`, async () => {
    const requests: Array<{ path: string; body: Record<string, unknown>; headers: IncomingHttpHeaders }> = [];
    const baseUrl = await service((path, body, headers) => {
      requests.push({ path, body, headers });
      if (path.endsWith('/models')) return { data: [{ id: 'fixture' }] };
      if (protocol === 'responses') return { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: '实际文本' }] }], usage: openaiUsage };
      if (protocol === 'messages') return { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '实际文本' }], stop_reason: 'end_turn', usage: anthropicUsage };
      return { choices: [{ message: { content: '实际文本' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } } };
    });
    const selected = model(baseUrl, protocol);
    const generated = await generateText({ model: selected, secret: 'fixture-secret', prompt: '真实请求内容', operationId: 'test:operation' });
    expect(generated).toMatchObject({ text: '实际文本', usage: { source: 'provider', inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 } });
    expect(typeof generated === 'string' ? undefined : generated.usage?.cachedOutputTokens).toBeUndefined();
    const request = requests[0];
    expect(request.path).toBe(`/gateway/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`);
    expect(request.body).toMatchObject({ model: 'fixture', temperature: .3, stream: false }); expect(request.body).not.toHaveProperty('size');
    expect(request.body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(128);
    if (protocol === 'responses') { expect(request.body.input).toEqual([{ role: 'user', content: '真实请求内容' }]); expect(request.body).not.toHaveProperty('messages'); expect(request.body.store).toBe(false); }
    else expect(request.body.messages).toEqual([{ role: 'user', content: '真实请求内容' }]);
    expect(request.headers['x-client-request-id']).toBe('test:operation');
    const connection = await testModelConnection(selected, 'fixture-secret'); expect(connection.connected).toBe(true); expect(connection.models).toEqual(['fixture']);
    expect(requests[1].path).toBe('/gateway/v1/models');
    for (const call of requests) {
      if (protocol === 'messages') { expect(call.headers['x-api-key']).toBe('fixture-secret'); expect(call.headers['anthropic-version']).toBe('2023-06-01'); expect(call.headers.authorization).toBeUndefined(); }
      else expect(call.headers.authorization).toBe('Bearer fixture-secret');
    }
  });
}

it('keeps old Claude-compatible profiles on Chat Completions and retains the Ollama native path', async () => {
  const paths: string[] = [];
  const baseUrl = await service(path => { paths.push(path); return path.endsWith('/api/chat') ? { message: { content: 'Ollama' }, prompt_eval_count: 3, eval_count: 2 } : { choices: [{ message: { content: 'legacy' } }] }; });
  const legacy = { ...model(baseUrl), platform: 'anthropic' as const };
  expect(await generateText({ model: legacy, prompt: 'legacy', operationId: 'legacy' })).toMatchObject({ text: 'legacy' });
  expect(await generateText({ model: { ...legacy, provider: 'ollama', parameters: { options: { num_predict: 128 } } }, prompt: 'native', operationId: 'native' })).toMatchObject({ text: 'Ollama', usage: { inputTokens: 3, outputTokens: 2 } });
  expect(paths).toEqual(['/gateway/v1/chat/completions', '/gateway/v1/api/chat']);
});

it('maps structured output and token aliases and rejects incomplete or empty native responses', async () => {
  const selected = model('http://localhost:1/v1', 'responses'); selected.parameters.response_format = { type: 'json_schema', json_schema: { name: 'draft', strict: true, schema: { type: 'object' } } };
  expect(textRequestParameters(selected)).toMatchObject({ max_output_tokens: 128, text: { format: { type: 'json_schema', name: 'draft' } } });
  expect(textRequestParameters({ ...selected, textProtocol: 'messages' })).toMatchObject({ max_tokens: 128, output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } });
  const baseUrl = await service(path => path.endsWith('/responses') ? { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }] } : { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' });
  for (const textProtocol of ['responses', 'messages'] as const) await expect(generateText({ model: model(baseUrl, textProtocol), prompt: 'input', operationId: textProtocol })).rejects.toThrow('未完整生成结果');
  const empty = await service(() => ({ content: [], output: [] }));
  for (const textProtocol of ['responses', 'messages'] as const) await expect(generateText({ model: model(empty, textProtocol), prompt: 'input', operationId: textProtocol })).rejects.toThrow('未返回文本');
  const signal = AbortSignal.abort(); await expect(generateText({ model: model(baseUrl, 'messages'), prompt: 'input', operationId: 'cancel', signal })).rejects.toThrow();
});

for (const { protocol, reportUsage } of [{ protocol: 'responses', reportUsage: true }, { protocol: 'messages', reportUsage: true }, { protocol: 'responses', reportUsage: false }] as const) {
  it(`runs a real ${protocol} Agent tool round-trip, preserves usage availability (${reportUsage}) and replays without another request`, async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseUrl = await service((path, body) => {
      calls.push({ path, body });
      const first = calls.length === 1;
      if (protocol === 'responses') return { id: `resp-${calls.length}`, object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: first ? [{ type: 'function_call', id: 'function-project', call_id: 'call-project', name: 'read_project_snapshot', arguments: '{}', status: 'completed' }] : [{ type: 'message', role: 'assistant', id: 'answer', status: 'completed', content: [{ type: 'output_text', text: '已读取固定项目快照。', annotations: [] }] }], ...(reportUsage ? { usage: openaiUsage } : {}) };
      return { id: `msg-${calls.length}`, type: 'message', role: 'assistant', model: 'fixture', content: first ? [{ type: 'tool_use', id: 'call-project', name: 'read_project_snapshot', input: {} }] : [{ type: 'text', text: '已读取固定项目快照。' }], stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null, usage: anthropicUsage };
    });
    const directory = await mkdtemp(join(tmpdir(), 'vq-text-protocol-')); directories.push(directory);
    const runtime = createRuntime({ dataDirectory: directory }); runtimes.push(runtime);
    const initial = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const selected = await runtime.dispatch('model.save', { model: { name: `Agent ${protocol}`, connectionType: 'text', provider: 'openai-compatible', textProtocol: protocol, baseUrl, model: 'fixture', capabilities: ['text'] } }) as ModelProfile;
    await runtime.dispatch('workflow.save', { projectId: initial.projects[0].id, workflow: { id: 'native-api', version: 1, name: 'native API', nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: selected.id })], edges: [] } });
    const run = await runtime.dispatch('run.start', { projectId: initial.projects[0].id }) as RunRecord; await runtime.waitForIdle();
    const after = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].error).toBeUndefined(); expect(after.runs[0].status).toBe('succeeded'); expect(calls).toHaveLength(2);
    expect(calls.every(call => call.path === `/gateway/v1/${protocol}`)).toBe(true);
    expect(JSON.stringify(calls[1].body)).toContain(protocol === 'responses' ? 'function_call_output' : 'tool_result');
    expect(after.runs[0].activities.filter(activity => activity.id.startsWith('agent:model:'))).toHaveLength(2);
    expect(JSON.stringify(calls[1].body)).toContain(initial.projects[0].id);
    const costs = await runtime.dispatch('cost.list', { runId: run.id }) as { items: Array<{ providerUsage?: Record<string, unknown> }> };
    expect(costs.items).toHaveLength(2); for (const cost of costs.items) {
      if (reportUsage) expect(cost.providerUsage).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 });
      else expect(cost.providerUsage).toBeUndefined();
    }
    await runtime.dispatch('run.replay', { runId: run.id }); expect(calls).toHaveLength(2);
  });
}
