import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { getModelVoiceCatalog, modelSchema } from '@video-quickly/contracts';
import { discoverModelVoices } from '../src/model-voices';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
function model(provider = 'qwen-tts', name = 'qwen3-tts-flash', baseUrl = 'http://127.0.0.1:1/api/v1') {
  return modelSchema.parse({ id: 'voice', name: '音色测试', provider, model: name, baseUrl, capabilities: ['tts'], createdAt: '', updatedAt: '' });
}
async function service(handler: (body: { model: string; input: { action: string; voice_id?: string; page_index: number } }, headers: IncomingHttpHeaders) => unknown) {
  const server = createServer(async (request, response) => {
    expect(request.url).toBe('/api/v1/services/audio/tts/customization'); expect(request.method).toBe('POST');
    let body = ''; for await (const chunk of request) body += chunk.toString();
    response.end(JSON.stringify(handler(JSON.parse(body), request.headers)));
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  return `http://127.0.0.1:${address.port}/api/v1`;
}

it('uses documented model-specific public voices without leaking them into unknown models or gateways', () => {
  const latest = getModelVoiceCatalog({ ...model('openai-compatible', 'gpt-4o-mini-tts'), platform: 'openai' });
  expect(latest.items).toHaveLength(13); expect(latest.items.some(voice => voice.id === 'marin')).toBe(true);
  const legacy = getModelVoiceCatalog({ ...model('openai-compatible', 'tts-1-hd'), platform: 'openai' });
  expect(legacy.items.some(voice => voice.id === 'marin')).toBe(false); expect(legacy.items.some(voice => voice.id === 'alloy')).toBe(true);
  expect(getModelVoiceCatalog({ ...model('openai-compatible', 'gpt-4o-mini-tts'), platform: 'custom' }).items).toEqual([]);
  expect(getModelVoiceCatalog(model('qwen-tts', 'qwen3-tts-flash-2025-11-27')).items).toContainEqual({ id: 'Cherry', label: '芊悦' });
  expect(getModelVoiceCatalog(model('qwen-tts', 'qwen3-tts-flash-realtime')).items).toEqual([]);
  expect(getModelVoiceCatalog(model('qwen-tts', 'qwen3-tts-vc')).items).toEqual([]);
  const v2 = getModelVoiceCatalog(model('volcengine-tts', 'seed-tts-2.0')), v1 = getModelVoiceCatalog(model('volcengine-tts', 'seed-tts-1.0'));
  expect(v2.items.some(voice => voice.id === 'zh_female_vv_uranus_bigtts')).toBe(true); expect(v1.items.some(voice => voice.id === 'zh_female_vv_uranus_bigtts')).toBe(false);
  expect(new Set(v1.items.map(voice => voice.id)).size).toBe(v1.items.length); expect(getModelVoiceCatalog(model('volcengine-tts', 'seed-icl-2.0')).items).toEqual([]);
});

it('reads account voices and confirms their exact target model without submitting training or synthesis', async () => {
  const actions: string[] = [];
  const base = await service((body, headers) => {
    expect(headers.authorization).toBe('Bearer fixture-key'); expect(body.model).toBe('voice-enrollment');
    actions.push(body.input.action);
    if (body.input.action === 'list_voice') { expect(body.input.page_index).toBe(0); return { output: { voice_list: [{ voice_id: 'same-model', status: 'OK' }, { voice_id: 'other-model', status: 'OK' }, { voice_id: 'unfinished', status: 'DEPLOYING' }] } }; }
    expect(body.input.action).toBe('query_voice');
    return { output: { target_model: body.input.voice_id === 'same-model' ? 'qwen3-tts-flash' : 'qwen3-tts-flash-2025-11-27', status: 'OK' } };
  });
  const result = await discoverModelVoices(model('qwen-tts', 'qwen3-tts-flash', base), 'fixture-key');
  expect(result.source).toBe('mixed'); expect(result.items.some(voice => voice.id === 'Cherry')).toBe(true); expect(result.items.some(voice => voice.id === 'same-model')).toBe(true);
  expect(result.items.some(voice => voice.id === 'other-model' || voice.id === 'unfinished')).toBe(false); expect(actions).toEqual(['list_voice', 'query_voice', 'query_voice']);
  expect((await discoverModelVoices(model('qwen-tts', 'qwen3-tts-flash', base))).source).toBe('preset'); expect(actions).toHaveLength(3);
});

it('paginates complete account lists and deduplicates IDs', async () => {
  const pages: number[] = [];
  const base = await service(body => {
    expect(body.input.action).toBe('list_voice'); pages.push(body.input.page_index);
    const voice = { voice_id: 'private-voice', status: 'OK', target_model: 'qwen3-tts-vc' };
    return { output: { voice_list: body.input.page_index ? [voice] : Array.from({ length: 50 }, () => voice) } };
  });
  const result = await discoverModelVoices(model('qwen-tts', 'qwen3-tts-vc', base), 'fixture-key');
  expect(pages).toEqual([0, 1]); expect(result.items).toEqual([{ id: 'private-voice', label: '账号音色 · private-voice' }]); expect(result.source).toBe('remote');
});
