import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, workflowNodeSchema, type ModelProfile, type RunRecord, type TextProtocol, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { discoverModels, generateText, shouldRetryWithPromptFormat, testModelConnection, textRequestParameters, TextRequestRejectedError } from '../src/providers.js';
import { createRuntime } from '../src/index.js';

const servers: Server[] = [], directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function service(handler: (path: string, body: Record<string, unknown>, headers: IncomingHttpHeaders, response: ServerResponse) => unknown) {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(handler(request.url ?? '', body ? JSON.parse(body) : {}, request.headers, response)));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。');
  return `http://127.0.0.1:${address.port}/gateway/v1`;
}
function model(baseUrl: string, textProtocol?: TextProtocol): ModelProfile {
  return modelSchema.parse({ id: 'model', name: '协议夹具', provider: 'openai-compatible', textProtocol, baseUrl, model: 'fixture', connectionType: 'text', capabilities: ['text', 'structured-output', 'image'], parameters: { temperature: .3, max_tokens: 128, size: '1024x1024' }, createdAt: '', updatedAt: '' });
}
const openaiUsage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } };
const anthropicUsage = { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 };

it('offers a prompt-only retry for empty incomplete Responses with automatic formatting', () => {
  const selected = model('http://127.0.0.1/v1', 'responses');
  const empty = { text: '', incomplete: true, incompleteReason: 'unknown' } as const;
  expect(shouldRetryWithPromptFormat(selected, empty)).toBe(true);
  expect(shouldRetryWithPromptFormat(selected, { ...empty, text: '部分内容' })).toBe(false);
  for (const incompleteReason of ['max_output_tokens', 'content_filter', 'provider_failed'] as const) {
    expect(shouldRetryWithPromptFormat(selected, { ...empty, incompleteReason })).toBe(false);
  }
  expect(shouldRetryWithPromptFormat({ ...selected, parameters: { text: { format: { type: 'json_schema' } } } }, empty)).toBe(false);
  expect(shouldRetryWithPromptFormat({ ...selected, textProtocol: 'messages' }, empty)).toBe(false);
});

for (const status of [400, 401, 403, 422, 429]) {
  it(`classifies HTTP ${status} as a confirmed rejection without disclosing or automatically retrying its body`, async () => {
    let calls = 0;
    const baseUrl = await service((_path, _body, _headers, response) => { calls++; response.statusCode = status; return { error: { message: 'private-provider-body fixture-key', code: 'invalid_request_error' } }; });
    await expect(generateText({ model: model(baseUrl), prompt: 'JSON', operationId: 'rejected', outputSchema: { type: 'object' } })).rejects.toMatchObject({ name: 'TextRequestRejectedError', status, unsupportedOutputFormat: false, message: expect.not.stringContaining('private-provider-body') });
    expect(calls).toBe(1);
  });
}
for (const status of [408, 409, 500, 503]) {
  it(`keeps HTTP ${status} outside confirmed request rejection recovery`, async () => {
    const baseUrl = await service((_path, _body, _headers, response) => { response.statusCode = status; return { error: { message: 'private-uncertain-body' } }; });
    try { await generateText({ model: model(baseUrl), prompt: 'JSON', operationId: 'uncertain' }); throw new Error('Expected request failure'); }
    catch (error) { expect(error).not.toBeInstanceOf(TextRequestRejectedError); expect(error).toMatchObject({ status }); }
  });
}
for (const protocol of ['chat-completions', 'responses', 'messages', 'ollama'] as const) {
  it(`falls back once after ${protocol} explicitly rejects an automatically added output format`, async () => {
    const calls: { body: Record<string, unknown>; id: string | string[] | undefined }[] = [];
    const baseUrl = await service((_path, body, headers, response) => {
      calls.push({ body, id: headers['x-client-request-id'] });
      if (calls.length === 1) { response.statusCode = 400; return { error: { param: 'text.format', code: 'unsupported_parameter', message: 'json_schema is not supported by this model' } }; }
      return protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"shots":[]}' }] }] } : protocol === 'messages' ? { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"shots":[]}' }] } : protocol === 'ollama' ? { message: { content: '{"shots":[]}' } } : { choices: [{ message: { content: '{"shots":[]}' } }] };
    });
    let fallbacks = 0;
    const selected = protocol === 'ollama' ? { ...model(baseUrl), provider: 'ollama' as const, parameters: {} } : model(baseUrl, protocol);
    expect(await generateText({ model: selected, prompt: '固定 JSON 提示词', operationId: 'fallback', outputSchema: { type: 'object' }, onOutputFormatFallback: () => fallbacks++ })).toMatchObject({ text: '{"shots":[]}' });
    expect(fallbacks).toBe(1); expect(calls).toHaveLength(2); expect(calls.map(call => call.id)).toEqual(['fallback', 'fallback:prompt-format']);
    const field = protocol === 'responses' ? 'text' : protocol === 'messages' ? 'output_config' : protocol === 'ollama' ? 'format' : 'response_format';
    expect(calls[0].body).toHaveProperty(field); expect(calls[1].body).not.toHaveProperty(field);
    const { [field]: _removed, ...original } = calls[0].body; expect(calls[1].body).toEqual(original);
  });
}
it('never overrides an explicit user format or replays a failed compatibility request', async () => {
  let calls = 0;
  const baseUrl = await service((_path, _body, _headers, response) => { calls++; response.statusCode = 400; return { error: { param: 'response_format', message: 'json_schema is not supported' } }; });
  const configured = { ...model(baseUrl), parameters: { response_format: { type: 'json_object' } } };
  await expect(generateText({ model: configured, prompt: 'JSON', operationId: 'configured', outputSchema: { type: 'object' } })).rejects.toBeInstanceOf(TextRequestRejectedError);
  expect(calls).toBe(1);
  calls = 0;
  await expect(generateText({ model: model(baseUrl), prompt: 'JSON', operationId: 'two-only', outputSchema: { type: 'object' } })).rejects.toBeInstanceOf(TextRequestRejectedError);
  expect(calls).toBe(2);
});

it('handles the MaaS 400001 Responses rejection by removing only the automatically added format', async () => {
  const calls: Record<string, unknown>[] = [];
  const baseUrl = await service((_path, body, _headers, response) => {
    calls.push(body);
    if (calls.length === 1) { response.statusCode = 400; return { error: { message: 'The request is invalid: the request was rejected by an internal MaaS component. Please check the request body, required fields, and request format.', type: 'invalid_request_error', param: '', code: '400001' } }; }
    return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"shots":[]}' }] }] };
  });
  let fallbacks = 0;
  expect(await generateText({ model: model(baseUrl, 'responses'), prompt: '本次冻结的 JSON 提示词', operationId: 'maas-format', outputSchema: { type: 'object' }, onOutputFormatFallback: () => fallbacks++ })).toMatchObject({ text: '{"shots":[]}' });
  expect(calls).toHaveLength(2); expect(fallbacks).toBe(1);
  expect(calls[0]).toHaveProperty('text.format.type', 'json_schema'); expect(calls[1]).not.toHaveProperty('text');
  const { text: _format, ...original } = calls[0]; expect(calls[1]).toEqual(original);
});

it('does not probe unrelated 400001 errors, explicit formats, or repeated MaaS rejections', async () => {
  let calls = 0, reason = 'The request was rejected by an internal MaaS component.';
  const baseUrl = await service((_path, _body, _headers, response) => { calls++; response.statusCode = 400; return { error: { message: reason, type: 'invalid_request_error', code: '400001' } }; });
  const selected = model(baseUrl, 'responses'), request = { model: selected, prompt: 'JSON', operationId: 'maas-rejection', outputSchema: { type: 'object' } };
  await expect(generateText(request)).rejects.toBeInstanceOf(TextRequestRejectedError); expect(calls).toBe(2);
  calls = 0;
  await expect(generateText({ ...request, model: { ...selected, parameters: { response_format: { type: 'json_object' } } } })).rejects.toBeInstanceOf(TextRequestRejectedError); expect(calls).toBe(1);
  calls = 0; reason = 'The context length exceeds the limit.';
  await expect(generateText(request)).rejects.toBeInstanceOf(TextRequestRejectedError); expect(calls).toBe(1);
});

it('adds protocol-specific JSON output constraints without replacing explicit model formats', () => {
  const schema = { type: 'object', properties: { shots: { type: 'array' } }, required: ['shots'] };
  const base = model('http://127.0.0.1:1');
  expect(textRequestParameters(base, schema)).toMatchObject({ response_format: { type: 'json_object' } });
  expect(textRequestParameters({ ...base, textProtocol: 'responses' }, schema)).toMatchObject({ text: { format: { type: 'json_schema', name: 'video_storyboard', schema, strict: false } } });
  expect(textRequestParameters({ ...base, textProtocol: 'messages' }, schema)).toMatchObject({ output_config: { format: { type: 'json_schema', schema } } });
  expect(textRequestParameters({ ...base, provider: 'ollama', parameters: {} }, schema)).toMatchObject({ format: schema });
  const configured = { type: 'json_schema', json_schema: { name: 'user_schema', schema: { type: 'object' } } };
  expect(textRequestParameters({ ...base, parameters: { response_format: configured } }, schema).response_format).toEqual(configured);
  expect(textRequestParameters(base)).not.toHaveProperty('response_format');
  expect(textRequestParameters({ ...base, capabilities: ['text'] }, schema)).not.toHaveProperty('response_format');
});

for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  it(`returns the raw truncated ${protocol} text for script validation and preserves usage`, async () => {
    const baseUrl = await service((_path, body) => {
      if (protocol === 'responses') { expect(body.text).toEqual({ format: { type: 'json_schema', name: 'video_storyboard', schema: { type: 'object' }, strict: false } }); return { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"shots":[' }] }], usage: openaiUsage }; }
      if (protocol === 'messages') { expect(body.output_config).toBeDefined(); return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"shots":[' }], usage: anthropicUsage }; }
      expect(body.response_format).toEqual({ type: 'json_object' }); return { choices: [{ finish_reason: 'length', message: { content: '{"shots":[' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
    });
    expect(await generateText({ model: model(baseUrl, protocol), prompt: '返回 JSON', operationId: 'structured-response', outputSchema: { type: 'object' } })).toMatchObject({ text: '{"shots":[', incomplete: true, usage: { outputTokens: 20 } });
  });
}

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

it('uses the selected Chat Completions protocol for a Claude gateway and the Ollama native path for a local model', async () => {
  const paths: string[] = [];
  const baseUrl = await service(path => { paths.push(path); return path.endsWith('/api/chat') ? { message: { content: 'Ollama' }, prompt_eval_count: 3, eval_count: 2 } : { choices: [{ message: { content: 'legacy' } }] }; });
  const relay = { ...model(baseUrl, 'chat-completions'), platform: 'anthropic' as const };
  expect(await generateText({ model: relay, prompt: 'fixture', operationId: 'chat' })).toMatchObject({ text: 'legacy' });
  expect(await generateText({ model: { ...relay, provider: 'ollama', parameters: { options: { num_predict: 128 } } }, prompt: 'native', operationId: 'native' })).toMatchObject({ text: 'Ollama', usage: { inputTokens: 3, outputTokens: 2 } });
  expect(paths).toEqual(['/gateway/v1/chat/completions', '/gateway/v1/api/chat']);
});

it('uses the configured Messages authentication for discovery, checks, direct requests and Agent calls at a full endpoint', async () => {
  const calls: Array<{ path: string; method: string | undefined; headers: IncomingHttpHeaders }> = [];
  let agentTurns = 0;
  const secret = 'bearer-fixture-token';
  const baseUrl = await service((path, body, headers, response) => {
    calls.push({ path, method: response.req.method, headers });
    if (headers.authorization !== `Bearer ${secret}` || headers['x-api-key']) { response.statusCode = 401; return {}; }
    if (path.startsWith('/gateway/v1/models')) return { data: [{ id: 'relay-model' }] };
    if (path !== '/relay/invoke') { response.statusCode = 404; return {}; }
    if (response.req.method === 'HEAD') { response.statusCode = 405; return {}; }
    const toolCall = Array.isArray(body.tools) && ++agentTurns === 1;
    return { id: `msg-${calls.length}`, type: 'message', role: 'assistant', model: 'relay-model', content: toolCall
      ? [{ type: 'tool_use', id: 'call-project', name: 'read_project_snapshot', input: {} }]
      : [{ type: 'text', text: '已读取项目。' }], stop_reason: toolCall ? 'tool_use' : 'end_turn', usage: anthropicUsage };
  });
  const prefix = model(baseUrl, 'messages');
  const relay = { ...prefix, model: 'relay-model', authMode: 'bearer' as const, capabilities: ['text', 'tools'] as ModelProfile['capabilities'] };
  expect((await discoverModels(relay, secret)).items.map(item => item.id)).toEqual(['relay-model']);
  expect(await testModelConnection(relay, secret)).toMatchObject({ connected: true, models: ['relay-model'] });
  const endpoint = { ...relay, baseUrl: `${new URL(baseUrl).origin}/relay/invoke`, fullUrl: true };
  expect((await discoverModels(endpoint, secret)).items).toEqual([]);
  expect(await testModelConnection(endpoint, secret)).toMatchObject({ connected: true, models: [] });
  expect(await generateText({ model: endpoint, secret, prompt: 'fixture', operationId: 'full-relay' })).toMatchObject({ text: '已读取项目。' });

  const directory = await mkdtemp(join(tmpdir(), 'vq-full-relay-')); directories.push(directory);
  const secrets = new Map<string, string>();
  const runtime = createRuntime({ dataDirectory: directory, seed: true, secretStore: {
    async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); },
  } });
  runtimes.push(runtime);
  const { projects: [project] } = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  const selected = modelSchema.parse(await runtime.dispatch('model.save', { model: endpoint, secret }));
  await runtime.dispatch('project.update', { projectId: project.id, patch: { workflow: {
    id: 'full-relay', version: 1, name: 'Full relay', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' },
    nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: selected.id })], edges: [],
  } } });
  await runtime.dispatch('run.start', { projectId: project.id }); await runtime.waitForIdle();
  expect((await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot).runs[0].status).toBe('succeeded');
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /gateway/v1/models?limit=1000', 'GET /gateway/v1/models', 'HEAD /relay/invoke', 'POST /relay/invoke', 'POST /relay/invoke', 'POST /relay/invoke',
  ]);
  for (const { headers } of calls) {
    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  }
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
    const runtime = createRuntime({ dataDirectory: directory, seed: true }); runtimes.push(runtime);
    const initial = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const selected = await runtime.dispatch('model.save', { model: { name: `Agent ${protocol}`, connectionType: 'text', provider: 'openai-compatible', textProtocol: protocol, baseUrl, model: 'fixture', capabilities: ['text', 'tools'] } }) as ModelProfile;
    await runtime.dispatch('project.update', { projectId: initial.projects[0].id, patch: { workflow: { id: 'native-api', version: 1, name: 'native API', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' }, nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: selected.id })], edges: [] } } });
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

it.each([{ modelId: 'gpt-5.6-terra', reasoning: false }, { modelId: 'deepseek-v4-pro', reasoning: true }])('keeps $modelId on Chat Completions through two Agent tool rounds', async ({ modelId, reasoning }) => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const baseUrl = await service((path, body) => {
    calls.push({ path, body });
    const turn = calls.length;
    const message = turn <= 2 ? {
      role: 'assistant', content: null,
      ...(reasoning ? { reasoning_content: `fixture-reasoning-${turn}` } : {}),
      tool_calls: [{ id: `call-project-${turn}`, type: 'function', function: { name: 'read_project_snapshot', arguments: '{}' } }],
    } : { role: 'assistant', content: '已读取项目快照。' };
    return { id: `chat-${turn}`, object: 'chat.completion', created: 1, model: modelId, choices: [{ index: 0, message, finish_reason: turn <= 2 ? 'tool_calls' : 'stop' }] };
  });
  const directory = await mkdtemp(join(tmpdir(), 'vq-agent-chat-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: true }); runtimes.push(runtime);
  const { projects: [project] } = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  const selected = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: modelId, connectionType: 'text', provider: 'openai-compatible', platform: reasoning ? 'deepseek' : 'custom',
    textProtocol: 'chat-completions', baseUrl, model: modelId, capabilities: ['text', 'tools'],
  } }));
  await runtime.dispatch('project.update', { projectId: project.id, patch: { workflow: {
    id: 'agent-chat', version: 1, name: 'Agent Chat', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' },
    nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: selected.id })], edges: [],
  } } });
  await runtime.dispatch('run.start', { projectId: project.id }); await runtime.waitForIdle();
  const after = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(after.runs[0]).toMatchObject({ status: 'succeeded' });
  expect(calls.map(call => call.path)).toEqual(Array(3).fill('/gateway/v1/chat/completions'));
  const last = calls[2].body.messages as Array<{ role: string; reasoning_content?: string; tool_call_id?: string }>;
  expect(last.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['call-project-1', 'call-project-2']);
  expect(last.flatMap(message => message.reasoning_content ? [message.reasoning_content] : [])).toEqual(reasoning ? ['fixture-reasoning-1', 'fixture-reasoning-2'] : []);
});

it('persists declared capabilities and rejects an Agent binding or protocol the model cannot use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-agent-capability-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: true }); runtimes.push(runtime);
  const { projects: [project] } = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  const profile = { name: 'OpenAI fixture', connectionType: 'text', provider: 'openai-compatible', platform: 'openai', model: 'gpt-6-astra', baseUrl: 'https://api.openai.com/v1' };
  await expect(runtime.dispatch('model.save', { model: { ...profile, capabilities: ['text', 'tools'], textProtocol: 'chat-completions' } })).rejects.toThrow('需要 Responses API');
  const plain = modelSchema.parse(await runtime.dispatch('model.save', { model: { ...profile, capabilities: ['text'] } }));
  const tools = modelSchema.parse(await runtime.dispatch('model.save', { model: { ...profile, capabilities: ['text', 'tools'], textProtocol: 'responses' } }));
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.models.find(model => model.id === plain.id)?.capabilities).toEqual(['text']);
  expect(snapshot.models.find(model => model.id === tools.id)?.capabilities).toEqual(['text', 'tools']);
  await runtime.dispatch('project.update', { projectId: project.id, patch: { workflow: {
    id: 'agent-capability', version: 1, name: 'Agent capability', production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' },
    nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: plain.id })], edges: [],
  } } });
  await expect(runtime.dispatch('run.start', { projectId: project.id })).rejects.toThrow('具备工具调用能力');
});
