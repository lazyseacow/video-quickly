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

it('reads authenticated compatible model lists, preserves IDs and deduplicates without a generation call', async () => {
  let calls = 0;
  const base = await service((request, response) => {
    calls++; expect(request.method).toBe('GET'); expect(request.url).toBe('/gateway/v1/models'); expect(request.headers.authorization).toBe('Bearer fixture-key');
    response.end(JSON.stringify({ data: [{ id: 'text-1' }, { id: 'image-1', display_name: 'Image' }, { id: 'text-1' }, { id: 5 }] }));
  });
  const result = await discoverModels(model(base), 'fixture-key');
  expect(result).toMatchObject({ source: 'remote', items: [{ id: 'text-1', label: 'text-1' }, { id: 'image-1', label: 'Image · image-1' }] }); expect(calls).toBe(1);
});

it('reads paginated Messages models and locally installed Ollama models', async () => {
  const paths: string[] = [];
  const base = await service((request, response) => {
    paths.push(request.url!);
    if (request.url?.endsWith('/api/tags')) { response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); return; }
    expect(request.headers['x-api-key']).toBe('fixture-key'); expect(request.headers['anthropic-version']).toBe('2023-06-01');
    const next = new URL(request.url!, 'http://localhost').searchParams.has('after_id');
    response.end(JSON.stringify({ data: [{ id: next ? 'claude-2' : 'claude-1' }], has_more: !next, last_id: next ? 'claude-2' : 'claude-1' }));
  });
  expect((await discoverModels(model(base, { textProtocol: 'messages', platform: 'anthropic' }), 'fixture-key')).items.map(item => item.id)).toEqual(['claude-1', 'claude-2']);
  expect((await discoverModels(model(base, { provider: 'ollama' }))).items).toEqual([{ id: 'qwen3:8b', label: 'qwen3:8b' }]);
  expect(paths).toEqual(['/gateway/v1/models?limit=1000', '/gateway/v1/models?limit=1000&after_id=claude-1', '/gateway/v1/api/tags']);
});

it('labels speech resource presets and workflow configuration separately from account model discovery', async () => {
  const tts = await discoverModels(model('http://127.0.0.1:1', { provider: 'volcengine-tts', capabilities: ['tts'] }));
  expect(tts.source).toBe('preset'); expect(tts.items.some(item => item.id === 'seed-tts-2.0')).toBe(true); expect(tts.message).toContain('开通');
  expect(await discoverModels(model('http://127.0.0.1:1', { provider: 'volcengine-asr', capabilities: ['asr'] }))).toMatchObject({ source: 'preset', items: [{ id: 'volc.bigasr.auc_turbo' }] });
  expect(await discoverModels(model('http://127.0.0.1:1', { provider: 'comfyui', capabilities: ['image'] }))).toMatchObject({ source: 'workflow', items: [{ id: 'workflow' }] });
});

it('reuses saved credentials only for the saved address and returns a manual fallback without saving drafts', async () => {
  let calls = 0;
  const base = await service((request, response) => { calls++; expect(request.headers.authorization).toBe('Bearer fixture-key'); response.writeHead(404); response.end('unsupported'); });
  const directory = await mkdtemp(join(tmpdir(), 'vq-discovery-')); directories.push(directory);
  const secrets = new Map<string, string>();
  const runtime = createRuntime({ dataDirectory: directory, secretStore: { async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } } }); runtimes.push(runtime);
  const saved = await runtime.dispatch('model.save', { model: model(base), secret: 'fixture-key' }) as ModelProfile;
  const result = await runtime.dispatch('model.discover', { model: saved }) as ModelDiscovery;
  expect(result.items).toEqual([]); expect(result.message).toContain('HTTP 404'); expect(JSON.stringify(result)).not.toContain('fixture-key');
  const changed = await runtime.dispatch('model.discover', { model: { ...saved, baseUrl: `${base}/changed` } }) as ModelDiscovery;
  expect(changed.message).toContain('地址已改变'); expect(calls).toBe(1);
  const voices = { ...saved, provider: 'qwen-tts', model: 'qwen3-tts-flash', capabilities: ['tts'] };
  const fallback = await runtime.dispatch('model.voices', { model: voices }) as ModelDiscovery;
  expect(fallback.items.some(voice => voice.id === 'Cherry')).toBe(true); expect(fallback.message).toContain('暂时无法读取'); expect(calls).toBe(2);
  const otherAddress = await runtime.dispatch('model.voices', { model: { ...voices, baseUrl: `${base}/other` } }) as ModelDiscovery;
  expect(otherAddress.message).toContain('地址已改变'); expect(calls).toBe(2);
  expect((await runtime.dispatch('workspace.summary') as { models: ModelProfile[] }).models).toHaveLength(1);
});
