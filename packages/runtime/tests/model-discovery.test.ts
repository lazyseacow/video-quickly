import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, type ModelDiscovery, type ModelProfile } from '@video-quickly/contracts';
import { discoverModels } from '../src/providers';
import { createRuntime } from '../src/index';

const servers: Server[] = [], directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function service(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  return `http://127.0.0.1:${address.port}/gateway/v1`;
}
function model(baseUrl: string, overrides: Partial<ModelProfile> = {}) {
  return modelSchema.parse({ id: 'fixture', name: '读取夹具', provider: 'openai-compatible', model: 'unused', baseUrl, capabilities: ['text'], createdAt: '', updatedAt: '', ...overrides });
}
async function runtimeWithSecrets() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-discovery-')); directories.push(directory);
  const secrets = new Map<string, string>();
  const runtime = createRuntime({ dataDirectory: directory, secretStore: { async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } } }); runtimes.push(runtime);
  return { runtime, secrets };
}

it('discovers and tests native Qwen TTS model IDs with saved credentials instead of using display names as IDs', async () => {
  const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
  const base = await service((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.end(JSON.stringify({ success: true, output: { total: 1, page_no: 1, page_size: 100, models: [{ model: 'qwen3-tts-flash', name: '千问语音合成', published_time: '2026-01-01T00:00:00Z', capabilities: ['TTS'] }] } }));
  });
  const { runtime, secrets } = await runtimeWithSecrets();
  const saved = await runtime.dispatch('model.save', { model: model(base, { provider: 'qwen-tts', platform: 'qwen-tts', connectionType: 'audio', model: 'qwen3-tts-flash', capabilities: ['tts'] }), secret: 'fixture-key' }) as ModelProfile;
  const result = await runtime.dispatch('model.discover', { model: saved }) as ModelDiscovery;
  expect(result.items).toEqual([{ id: 'qwen3-tts-flash', label: '千问语音合成 · qwen3-tts-flash' }]);
  const tested = await runtime.dispatch('model.test', { modelId: saved.id }) as { connected: boolean; models: string[]; message: string };
  expect(tested).toMatchObject({ connected: true, models: ['qwen3-tts-flash'] }); expect(tested.message).toContain('已找到配置的模型');
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    const url = new URL(request.url!, base);
    expect(request.method).toBe('GET'); expect(url.pathname).toBe('/gateway/v1/models'); expect(url.searchParams.get('capabilities')).toBe('TTS'); expect(url.searchParams.get('page_no')).toBe('1');
    expect(request.authorization).toBe('Bearer fixture-key');
  }
  expect(secrets.size).toBe(1); expect(JSON.stringify({ result, tested })).not.toContain('fixture-key');
  expect((await runtime.dispatch('workspace.summary') as { models: ModelProfile[] }).models.filter(value => value.id === saved.id)).toHaveLength(1);
});

it('reads every Qwen catalogue page, filters supported TTS models and sorts deduplicated IDs by published time', async () => {
  const pages: string[] = [];
  const base = await service((request, response) => {
    const page = new URL(request.url!, 'http://localhost').searchParams.get('page_no') ?? '1'; pages.push(page);
    response.end(JSON.stringify({ output: { total: 9, page_no: Number(page), page_size: 5, models: page === '1' ? [
      { model: 'qwen3-tts-flash', name: '通用配音', published_time: '2025-01-01 00:00:00', capabilities: ['TTS'] },
      { model: 'qwen3-tts-flash-latest', name: '最新配音', published_time: '2026-01-01 00:00:00', capabilities: ['TTS'] },
      { model: 'qwen3-vl-plus', name: '视觉模型', capabilities: ['MultimodalGeneration'] },
      { model: 'qwen-audio-3.1-tts-flash', name: '另一合成接口', capabilities: ['TTS'] },
      { model: 'qwen3-tts-flash-undated', name: '无发布时间', published_time: null, capabilities: ['TTS'] },
    ] : [
      { model: 'qwen3-tts-flash', name: '通用配音', published_time: '2024-01-01T00:00:00Z', capabilities: ['TTS'] },
      { model: 'qwen3-tts-flash-realtime', name: '实时配音', capabilities: ['TTS'] },
      { model: 'cosyvoice-v3-flash', name: '另一协议的配音模型', capabilities: ['TTS'] },
      { model: 'voice-enrollment', name: '音色定制模型', capabilities: ['TTS'] },
    ] } }));
  });
  const result = await discoverModels(model(base, { provider: 'qwen-tts', capabilities: ['tts'] }));
  expect(pages).toEqual(['1', '2']);
  expect(result.items).toEqual([{ id: 'qwen3-tts-flash-latest', label: '最新配音 · qwen3-tts-flash-latest' }, { id: 'qwen3-tts-flash', label: '通用配音 · qwen3-tts-flash' }, { id: 'qwen3-tts-flash-undated', label: '无发布时间 · qwen3-tts-flash-undated' }]);
  expect(result.message).toContain('已读取 3 个模型');
});

it.each(['data', 'models'] as const)('keeps Qwen compatible %s catalogues usable and preserves model IDs ahead of names', async shape => {
  const base = await service((_request, response) => response.end(JSON.stringify({ [shape]: [
    { model: 'qwen3-tts-flash', name: '配音显示名', published_time: '2026-01-01T00:00:00Z' },
    { id: 'qwen-tts-latest', display_name: '旧版兼容型号' },
    { id: 'qwen3-tts-flash-not-tts', capabilities: ['ASR'] },
    { id: 'qwen3-max', capabilities: ['TextGeneration'] },
  ] })));
  expect((await discoverModels(model(base, { provider: 'qwen-tts', capabilities: ['tts'] }))).items).toEqual([
    { id: 'qwen3-tts-flash', label: '配音显示名 · qwen3-tts-flash' }, { id: 'qwen-tts-latest', label: '旧版兼容型号 · qwen-tts-latest' },
  ]);
});

it.each([
  { success: false, data: [{ id: 'qwen3-tts-flash' }] },
  { code: 'InvalidApiKey', message: 'sensitive-vendor-detail', output: { total: 1, page_no: 1, page_size: 100, models: [{ model: 'qwen3-tts-flash', capabilities: ['TTS'] }] } },
  { output: { total: 1, page_no: 1, page_size: 100, models: {} } },
  { output: { total: 1, models: [] } },
  { output: { total: 2, page_no: 1, page_size: 1, models: [] } },
  { data: [{ id: 'qwen3-tts-flash' }], has_more: true, last_id: 'qwen3-tts-flash' },
])('rejects failed or malformed Qwen catalogues instead of showing a successful empty list: %j', async payload => {
  const base = await service((_request, response) => response.end(JSON.stringify(payload)));
  await expect(discoverModels(model(base, { provider: 'qwen-tts', capabilities: ['tts'] }))).rejects.toThrow(/模型列表|分页/);
});

it('rejects a repeated Qwen page instead of returning an incomplete catalogue', async () => {
  let calls = 0;
  const base = await service((_request, response) => { calls++; response.end(JSON.stringify({ output: { total: 2, page_no: 1, page_size: 1, models: [{ model: 'qwen3-tts-flash', capabilities: ['TTS'] }] } })); });
  await expect(discoverModels(model(base, { provider: 'qwen-tts', capabilities: ['tts'] }))).rejects.toThrow(/完整|分页/); expect(calls).toBe(2);
});

it('reports a retryable incomplete Qwen catalogue when the page budget is exhausted', async () => {
  let calls = 0;
  const base = await service((request, response) => {
    calls++; const page = Number(new URL(request.url!, 'http://localhost').searchParams.get('page_no') ?? '1');
    response.end(JSON.stringify({ output: { total: 21, page_no: page, page_size: 1, models: [{ model: `qwen3-tts-flash-${page}`, capabilities: ['TTS'] }] } }));
  });
  await expect(discoverModels(model(base, { provider: 'qwen-tts', capabilities: ['tts'] }))).rejects.toThrow(/完整|分页/); expect(calls).toBe(20);
});

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
  { connectionType: 'video', capabilities: ['video'], expected: ['sora-2'] },
  { connectionType: 'audio', capabilities: ['tts'], expected: ['tts-1-hd', 'gpt-4o-mini-tts'] },
  { connectionType: 'audio', capabilities: ['asr'], expected: ['gpt-4o-transcribe-diarize', 'gpt-4o-mini-transcribe-2025-12-15', 'whisper-1'] },
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
  expect(result.message).toContain('未返回可用模型');
});

it('asks to retry when OpenAI returns no models for the selected connection type', async () => {
  const base = await service((_request, response) => response.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'whisper-1' }] })));
  const result = await discoverModels(model(base, { platform: 'openai', connectionType: 'text' }));
  expect(result.items).toEqual([]);
  expect(result.message).toContain('未返回适合当前连接类型的模型');
  expect(result.message).not.toContain('手动填写');
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

it('labels speech resource presets and workflow configuration separately from account model discovery', async () => {
  const tts = await discoverModels(model('http://127.0.0.1:1', { provider: 'volcengine-tts', capabilities: ['tts'] }));
  expect(tts.source).toBe('preset'); expect(tts.items.some(item => item.id === 'seed-tts-2.0')).toBe(true); expect(tts.message).toContain('开通');
  expect(await discoverModels(model('http://127.0.0.1:1', { provider: 'volcengine-asr', capabilities: ['asr'] }))).toMatchObject({ source: 'preset', items: [{ id: 'volc.bigasr.auc_turbo' }] });
  expect(await discoverModels(model('http://127.0.0.1:1', { provider: 'comfyui', capabilities: ['image'] }))).toMatchObject({ source: 'workflow', items: [{ id: 'workflow' }] });
});

it('reuses saved credentials only for the saved address and returns a retry message without saving drafts', async () => {
  let calls = 0;
  const base = await service((request, response) => { calls++; expect(request.headers.authorization).toBe('Bearer fixture-key'); response.writeHead(404); response.end('unsupported'); });
  const { runtime } = await runtimeWithSecrets();
  const saved = await runtime.dispatch('model.save', { model: model(base), secret: 'fixture-key' }) as ModelProfile;
  const result = await runtime.dispatch('model.discover', { model: saved }) as ModelDiscovery;
  expect(result.items).toEqual([]); expect(result.message).toContain('HTTP 404'); expect(JSON.stringify(result)).not.toContain('fixture-key');
  expect(result.message).not.toContain('手动填写');
  const changed = await runtime.dispatch('model.discover', { model: { ...saved, baseUrl: `${base}/changed` } }) as ModelDiscovery;
  expect(changed.message).toContain('地址已改变'); expect(calls).toBe(1);
  const voices = { ...saved, provider: 'qwen-tts', model: 'qwen3-tts-flash', capabilities: ['tts'] };
  const fallback = await runtime.dispatch('model.voices', { model: voices }) as ModelDiscovery;
  expect(fallback.items.some(voice => voice.id === 'Cherry')).toBe(true); expect(fallback.message).toContain('暂时无法读取'); expect(calls).toBe(2);
  const otherAddress = await runtime.dispatch('model.voices', { model: { ...voices, baseUrl: `${base}/other` } }) as ModelDiscovery;
  expect(otherAddress.message).toContain('地址已改变'); expect(calls).toBe(2);
  expect((await runtime.dispatch('workspace.summary') as { models: ModelProfile[] }).models).toHaveLength(1);
});
