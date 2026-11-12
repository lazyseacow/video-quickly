import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelDiscoverySchema, modelSchema, type ModelProfile } from '@video-quickly/contracts';
import { discoverModels, generateText, testModelConnection } from '../src/providers';
import { createRuntime } from '../src/index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
});
async function service(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  return `http://127.0.0.1:${address.port}/gateway/v1`;
}
function model(baseUrl: string, overrides: Partial<ModelProfile> = {}) {
  return modelSchema.parse({ id: 'fixture', name: '读取夹具', provider: 'openai-compatible', model: 'unused', baseUrl, connectionType: 'text', capabilities: ['text'], createdAt: '', updatedAt: '', ...overrides });
}
it('reads authenticated compatible model lists, preserves IDs and deduplicates without a generation call', async () => {
  let calls = 0;
  const base = await service((request, response) => {
    calls++; expect(request.method).toBe('GET'); expect(request.url).toBe('/gateway/v1/models'); expect(request.headers.authorization).toBe('Bearer fixture-key');
    response.end(JSON.stringify({ data: [{ id: 'text-1' }, { id: 'image-1', display_name: 'Image' }, { id: 'text-1' }, { id: 5 }] }));
  });
  const result = await discoverModels(model(base), 'fixture-key');
  expect(result).toMatchObject({ source: 'remote', items: [{ id: 'text-1', label: 'text-1' }, { id: 'image-1', label: 'Image · image-1' }] }); expect(calls).toBe(1);
});

it.each<{ connectionType: ModelProfile['connectionType']; capabilities: ModelProfile['capabilities']; expected: string[] }>([
  { connectionType: 'text', capabilities: ['text', 'vision'], expected: ['ft:gpt-4o-mini:fixture:audio-image-assistant:id', 'chatgpt-4o-latest', 'o3-mini', 'codex-mini-latest', 'gpt-4.1', 'gpt-4o'] },
  { connectionType: 'image', capabilities: ['image'], expected: ['chatgpt-image-latest', 'dall-e-3', 'gpt-image-1'] },
])('filters OpenAI models for $connectionType $capabilities while preserving newest-first order', async ({ connectionType, capabilities, expected }) => {
  const base = await service((_request, response) => {
    const ids = ['gpt-4o', 'gpt-image-1', 'gpt-4o-mini-tts', 'whisper-1', 'sora-2', 'gpt-4.1', 'gpt-4o-realtime-preview', 'gpt-realtime', 'gpt-audio-mini', 'gpt-4o-audio-preview', 'gpt-4o-mini-transcribe-2025-12-15', 'gpt-4o-transcribe-diarize', 'tts-1-hd', 'dall-e-3', 'chatgpt-image-latest', 'text-embedding-3-large', 'omni-moderation-latest', 'babbage-002', 'codex-mini-latest', 'o3-mini', 'chatgpt-4o-latest', 'ft:gpt-4o-mini:fixture:audio-image-assistant:id'];
    response.end(JSON.stringify({ data: [...ids.map((id, index) => ({ id, created: 1_700_000_000 + index })), { id: 'o1', created: 1_800_000_000, shutdown_date: '2000-01-01' }] }));
  });
  const result = await discoverModels(model(base, { platform: 'openai', connectionType, capabilities }));
  expect(result.items.map(item => item.id)).toEqual(expected);
  expect(result.message).toContain('按当前连接类型筛选');
});

it('sorts discovered models newest first, keeps ties stable and puts missing or invalid times last', async () => {
  const base = await service((_request, response) => {
    response.end(JSON.stringify({ data: [
      { id: 'undated' },
      { id: 'oldest', created: Date.UTC(2024, 0, 1) / 1000 },
      { id: 'newest', created_at: '2026-10-30T08:00:00+08:00', display_name: '最新模型' },
      { id: 'milliseconds', created: Date.UTC(2025, 0, 1) },
      { id: 'same-time', created: String(Date.UTC(2026, 9, 30) / 1000) },
      { id: 'invalid', created: 'not-a-date' },
      { id: 'missing', created: null },
      { id: 'newest' },
      { id: 'fallback-time', created: 'invalid', created_at: '2025-10-01T00:00:00Z' },
      { id: 'newest', created: Date.UTC(2023, 0, 1) / 1000, display_name: '最新模型' },
    ] }));
  });
  const result = await discoverModels(model(base));
  expect(result.items).toEqual([
    { id: 'newest', label: '最新模型 · newest' },
    { id: 'same-time', label: 'same-time' },
    { id: 'fallback-time', label: 'fallback-time' },
    { id: 'milliseconds', label: 'milliseconds' },
    { id: 'oldest', label: 'oldest' },
    { id: 'undated', label: 'undated' },
    { id: 'invalid', label: 'invalid' },
    { id: 'missing', label: 'missing' },
  ]);
});

it('excludes retired models and elapsed shutdown dates while keeping models that are still available', async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const base = await service((_request, response) => {
    response.end(JSON.stringify({ data: [
      { id: 'o1', shutdown_date: yesterday },
      { id: 'retired-model', lifecycle: 'retired' },
      { id: 'scheduled-shutdown', shutdown_date: tomorrow },
      { id: 'deprecated-but-callable', lifecycle: 'deprecated', deprecated_at: yesterday, retires_at: yesterday },
      { id: 'no-shutdown', shutdown_date: null },
      { id: 'invalid-shutdown', shutdown_date: 'not-a-date' },
    ] }));
  });
  const result = await discoverModels(model(base));
  expect(result.items.map(item => item.id)).toEqual(['scheduled-shutdown', 'deprecated-but-callable', 'no-shutdown', 'invalid-shutdown']);
  expect(result.message).toContain('已读取 4 个模型');
});

it('reports an empty usable catalogue when the service only returns retired models', async () => {
  const base = await service((_request, response) => response.end(JSON.stringify({ data: [{ id: 'retired-model', lifecycle: 'retired' }] })));
  const result = await discoverModels(model(base));
  expect(result.items).toEqual([]);
  expect(result.message).toContain('未返回适合当前连接类型的模型');
});

it('asks to retry when OpenAI returns no models for the selected connection type', async () => {
  const base = await service((_request, response) => response.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'whisper-1' }] })));
  const result = await discoverModels(model(base, { platform: 'openai', connectionType: 'text' }));
  expect(result.items).toEqual([]);
  expect(result.message).toContain('未返回适合当前连接类型的模型');
  expect(result.message).toContain('请核对连接后重试');
});

it('omits the retired official Videos API while keeping the compatible gateway catalogue', async () => {
  const base = await service((_request, response) => response.end(JSON.stringify({ data: [{ id: 'sora-2' }] })));
  const video = model(base, { connectionType: 'video', capabilities: ['video'], platform: 'custom' });
  expect((await discoverModels({ ...video, platform: 'openai' })).items).toEqual([]);
  expect((await discoverModels(video)).items).toEqual([{ id: 'sora-2', label: 'sora-2' }]);
});

it('uses Ark output modalities for each model role and exposes reported text capabilities', async () => {
  const base = await service((_request, response) => response.end(JSON.stringify({ data: [
    { id: 'vision-chat', domain: 'VLM', modalities: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, features: { tools: { function_calling: true }, structured_outputs: { json_object: false, json_schema: true } } },
    { id: 'text-only', domain: 'LLM', features: { tools: { function_calling: false } } },
    { id: 'paint', domain: 'ImageGeneration' },
    { id: 'movie', modalities: { output_modalities: ['video'] } },
    { id: 'speech', domain: 'Audio' },
  ] })));
  expect((await discoverModels(model(base, { platform: 'seedance', provider: 'seedance', connectionType: 'video', capabilities: ['video'] }))).items.map(item => item.id)).toEqual(['movie']);
  expect((await discoverModels(model(base, { platform: 'seedream', provider: 'seedream', connectionType: 'image', capabilities: ['image'] }))).items.map(item => item.id)).toEqual(['paint']);
  const text = model(base, { platform: 'volcengine' });
  expect((await discoverModels(text)).items.map(item => item.capabilities)).toEqual([['text', 'vision', 'tools'], ['text']]);
  expect((await discoverModels({ ...text, textProtocol: 'responses' })).items[0].capabilities).toEqual(['text', 'vision', 'tools', 'structured-output']);
});

it('scopes saved keys to the connection origin during discovery, save, and subsequent checks', async () => {
  const headers: Array<string | undefined> = [];
  function catalogue(request: IncomingMessage, response: ServerResponse) {
    headers.push(request.headers.authorization);
    response.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
  }
  const original = await service(catalogue), differentOrigin = await service(catalogue);
  const directory = await mkdtemp(join(tmpdir(), 'vq-model-origin-'));
  const keys = new Map<string, string>();
  const runtime = createRuntime({ dataDirectory: directory, secretStore: {
    async get(key) { return keys.get(key); }, async set(key, value) { keys.set(key, value); }, async delete(key) { keys.delete(key); },
  } });
  try {
    const saved = modelSchema.parse(await runtime.dispatch('model.save', { model: model(original), secret: 'original-fixture-key' }));
    const sameOrigin = { ...saved, baseUrl: `${new URL(original).origin}/alternate` };
    await runtime.dispatch('model.discover', { model: sameOrigin });
    expect(modelSchema.parse(await runtime.dispatch('model.save', { model: sameOrigin })).credentialRef).toBe(saved.credentialRef);
    const other = { ...saved, baseUrl: differentOrigin };
    await runtime.dispatch('model.discover', { model: other, reuseSavedSecret: true });
    const detached = modelSchema.parse(await runtime.dispatch('model.save', { model: other }));
    expect(detached.hasSecret).toBe(false);
    expect(detached.credentialRef).toBeUndefined();
    await runtime.dispatch('model.test', { modelId: saved.id });
    const replacement = modelSchema.parse(await runtime.dispatch('model.save', { model: other, secret: 'new-fixture-key' }));
    expect(replacement.credentialRef).not.toBe(saved.credentialRef);
    await runtime.dispatch('model.test', { modelId: saved.id });
    expect(headers).toEqual(['Bearer original-fixture-key', undefined, undefined, 'Bearer new-fixture-key']);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('blocks cross-origin model redirects and retains the key through a same-origin redirect', async () => {
  const received: Array<string | undefined> = [];
  const other = await service((request, response) => { received.push(request.headers['x-api-key'] as string | undefined); response.end('{}'); });
  const base = await service((request, response) => {
    if (request.url === '/same-origin/models?limit=1000') { response.writeHead(302, { Location: '/catalogue' }).end(); return; }
    if (request.url === '/catalogue') {
      expect(request.headers['x-api-key']).toBe('fixture-key');
      response.end(JSON.stringify({ data: [{ id: 'same-origin-model' }] })); return;
    }
    response.writeHead(302, { Location: `${other}/target` }).end();
  });
  const selected = model(base, { textProtocol: 'messages' });
  await expect(discoverModels(selected, 'fixture-key')).rejects.toThrow('其他来源');
  await expect(testModelConnection(selected, 'fixture-key')).rejects.toThrow('其他来源');
  await expect(generateText({ model: selected, secret: 'fixture-key', prompt: 'fixture', operationId: 'redirect' })).rejects.toThrow('其他来源');
  expect(received).toEqual([]);
  const safe = await discoverModels({ ...selected, baseUrl: `${new URL(base).origin}/same-origin` }, 'fixture-key');
  expect(safe.items.map(item => item.id)).toEqual(['same-origin-model']);
});

it('reads paginated Messages models and locally installed Ollama models', async () => {
  const paths: string[] = [];
  const base = await service((request, response) => {
    paths.push(request.url!);
    if (request.url?.endsWith('/api/tags')) { response.end(JSON.stringify({ models: [{ name: 'qwen3:8b', modified_at: '2025-01-01T00:00:00Z' }, { name: 'local-model' }, { name: 'new-local-model', modified_at: '2026-10-30T00:00:00Z' }] })); return; }
    expect(request.headers['x-api-key']).toBe('fixture-key'); expect(request.headers['anthropic-version']).toBe('2023-06-01');
    const next = new URL(request.url!, 'http://localhost').searchParams.has('after_id');
    response.end(JSON.stringify({ data: [{ id: next ? 'claude-2' : 'claude-1', created_at: next ? '2026-10-30T00:00:00Z' : '2025-01-01T00:00:00Z' }], has_more: !next, last_id: next ? 'claude-2' : 'claude-1' }));
  });
  expect((await discoverModels(model(base, { textProtocol: 'messages', platform: 'qwen' }), 'fixture-key')).items.map(item => item.id)).toEqual(['claude-2', 'claude-1']);
  expect((await discoverModels(model(base, { provider: 'ollama' }))).items).toEqual([{ id: 'new-local-model', label: 'new-local-model' }, { id: 'qwen3:8b', label: 'qwen3:8b' }, { id: 'local-model', label: 'local-model' }]);
  expect(paths).toEqual(['/gateway/v1/models?limit=1000', '/gateway/v1/models?limit=1000&after_id=claude-1', '/gateway/v1/api/tags']);
});

it('uses the Ollama API prefix for catalogue, connection check and generation', async () => {
  const calls: string[] = [];
  const base = await service((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === '/gateway/v1/api/tags') response.end(JSON.stringify({ models: [{ name: 'fixture' }] }));
    else if (request.url === '/gateway/v1/api/chat') response.end(JSON.stringify({ message: { content: 'Ollama' } }));
    else response.writeHead(404).end();
  });
  const selected = model(`${base}/api/`, { provider: 'ollama', model: 'fixture' });
  expect((await discoverModels(selected)).items.map(item => item.id)).toEqual(['fixture']);
  await expect(testModelConnection(selected)).resolves.toMatchObject({ connected: true, models: ['fixture'] });
  await expect(generateText({ model: selected, prompt: 'fixture', operationId: 'ollama-prefix' })).resolves.toMatchObject({ text: 'Ollama' });
  expect(calls).toEqual(['GET /gateway/v1/api/tags', 'GET /gateway/v1/api/tags', 'POST /gateway/v1/api/chat']);
});

it('uses versioned Messages and model routes with the official Claude host as the base', async () => {
  const selected = model('https://api.anthropic.com', { textProtocol: 'messages', model: 'fixture' });
  const calls: string[] = [];
  const service = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const request = new Request(input);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.anthropic.com');
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture' }] });
    if (url.pathname === '/v1/messages') return Response.json({ content: [{ type: 'text', text: 'Claude' }], stop_reason: 'end_turn' });
    return new Response(null, { status: 404 });
  });
  try {
    expect((await discoverModels(selected)).items.map(item => item.id)).toEqual(['fixture']);
    await expect(testModelConnection(selected)).resolves.toMatchObject({ connected: true, models: ['fixture'] });
    await expect(generateText({ model: selected, prompt: 'fixture', operationId: 'claude-prefix' })).resolves.toMatchObject({ text: 'Claude' });
    expect(calls).toEqual(['GET /v1/models?limit=1000', 'GET /v1/models', 'POST /v1/messages']);
  } finally { service.mockRestore(); }
});

it('reads and saves Bailian Messages models from the paginated workspace catalogue', async () => {
  const origin = 'https://fixture.cn-beijing.maas.aliyuncs.com';
  const selected = model(`${origin}/apps/anthropic`, { platform: 'qwen', textProtocol: 'messages' });
  const secret = 'bailian-fixture-key';
  const calls: string[] = [];
  const service = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const request = new Request(input), url = new URL(request.url);
    expect(url.origin).toBe(origin);
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/v1/models') {
      expect(request.headers.get('authorization')).toBe(`Bearer ${secret}`);
      expect(request.headers.get('x-api-key')).toBeNull();
      const page = Number(url.searchParams.get('page_no'));
      const models = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ model: `qwen-${index}` }))
        : [{ model: 'qwen-picked', name: '百炼候选' }];
      return Response.json({ output: { page_no: page, page_size: 100, total: 101, models } });
    }
    if (url.pathname === '/apps/anthropic/v1/messages') {
      expect(request.headers.get('x-api-key')).toBe(secret);
      expect(request.headers.get('authorization')).toBeNull();
      expect(await request.json()).toMatchObject({ model: 'qwen-picked' });
      return Response.json({ content: [{ type: 'text', text: '百炼' }], stop_reason: 'end_turn' });
    }
    return new Response(null, { status: 404 });
  });
  const directory = await mkdtemp(join(tmpdir(), 'vq-bailian-catalog-'));
  const keys = new Map<string, string>();
  const runtime = createRuntime({ dataDirectory: directory, secretStore: {
    async get(key) { return keys.get(key); }, async set(key, value) { keys.set(key, value); }, async delete(key) { keys.delete(key); },
  } });
  try {
    const discovery = modelDiscoverySchema.parse(await runtime.dispatch('model.discover', { model: selected, secret }));
    expect(discovery.items).toHaveLength(101);
    const picked = discovery.items.at(-1)!;
    expect(picked).toMatchObject({ id: 'qwen-picked', label: '百炼候选 · qwen-picked' });
    const saved = modelSchema.parse(await runtime.dispatch('model.save', { model: { ...selected, model: picked.id }, secret }));
    expect(saved).toMatchObject({ model: picked.id, baseUrl: selected.baseUrl });
    const full = { ...saved, baseUrl: `${origin}/apps/anthropic/v1/messages`, fullUrl: true };
    const rediscovered = modelDiscoverySchema.parse(await runtime.dispatch('model.discover', { model: full }));
    expect(rediscovered.items).toEqual(discovery.items);
    await expect(runtime.dispatch('model.test', { modelId: saved.id })).resolves.toMatchObject({ connected: true, models: expect.arrayContaining([picked.id]) });
    await expect(generateText({ model: saved, secret, prompt: 'fixture', operationId: 'bailian-messages' })).resolves.toMatchObject({ text: '百炼' });
    const pages = [1, 2].map(page => `GET /api/v1/models?capabilities=TG&page_size=100&page_no=${page}`);
    expect(calls).toEqual([...pages, ...pages, ...pages, 'POST /apps/anthropic/v1/messages']);
  } finally {
    service.mockRestore();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { origin: 'https://api.moonshot.cn', path: '/v1', fullUrl: false },
  { origin: 'https://api.moonshot.cn', path: '/anthropic', fullUrl: false },
  { origin: 'https://api.moonshot.ai', path: '/anthropic/v1/messages', fullUrl: true },
])('uses the official Kimi catalogue for Messages at $origin $path', async ({ origin, path, fullUrl }) => {
  const selected = model(origin + path, { platform: 'moonshot', textProtocol: 'messages', fullUrl, model: 'kimi-fixture' });
  const calls: string[] = [];
  const service = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const request = new Request(input), url = new URL(request.url);
    expect(url.origin).toBe(origin);
    expect(request.headers.get('authorization')).toBe('Bearer kimi-fixture-key');
    expect(request.headers.get('x-api-key')).toBeNull();
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: selected.model, object: 'model' }] });
    if (url.pathname === '/anthropic/v1/messages') return Response.json({ content: [{ type: 'text', text: 'Kimi' }], stop_reason: 'end_turn' });
    return new Response(null, { status: 404 });
  });
  try {
    const secret = 'kimi-fixture-key';
    expect((await discoverModels(selected, secret)).items).toEqual([{ id: selected.model, label: selected.model }]);
    await expect(testModelConnection(selected, secret)).resolves.toMatchObject({ connected: true, models: [selected.model] });
    await expect(generateText({ model: selected, secret, prompt: 'fixture', operationId: 'kimi-messages' })).resolves.toMatchObject({ text: 'Kimi' });
    expect(calls).toEqual(['GET /v1/models', 'GET /v1/models', 'POST /anthropic/v1/messages']);
  } finally { service.mockRestore(); }
});
