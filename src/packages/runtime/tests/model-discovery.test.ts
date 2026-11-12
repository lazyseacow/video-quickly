import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, type ModelProfile } from '@video-quickly/contracts';
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
  expect(result.message).toContain('手动填写');
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
  expect((await discoverModels(model(base, { textProtocol: 'messages', platform: 'anthropic' }), 'fixture-key')).items.map(item => item.id)).toEqual(['claude-2', 'claude-1']);
  expect((await discoverModels(model(base, { provider: 'ollama' }))).items).toEqual([{ id: 'new-local-model', label: 'new-local-model' }, { id: 'qwen3:8b', label: 'qwen3:8b' }, { id: 'local-model', label: 'local-model' }]);
  expect(paths).toEqual(['/gateway/v1/models?limit=1000', '/gateway/v1/models?limit=1000&after_id=claude-1', '/gateway/v1/api/tags']);
});
