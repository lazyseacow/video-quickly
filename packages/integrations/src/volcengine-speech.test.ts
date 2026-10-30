import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, validateModelParameters } from '@video-quickly/contracts';
import { synthesizeVolcengineSpeech, volcengineSpeechHeaders } from './volcengine-speech';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

it('sends native Doubao synthesis and assembles streamed audio across arbitrary network boundaries', async () => {
  const requests: Array<{ headers: Record<string, unknown>; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString(); requests.push({ headers: request.headers, body: JSON.parse(text) });
    expect(request.url).toBe('/api/v3/tts/unidirectional');
    response.setHeader('content-type', 'application/json');
    const frames = [{ code: 0, data: Buffer.from('audio-a').toString('base64') }, { code: 0, data: Buffer.from('audio-b').toString('base64') }, { code: 20000000, usage: { text_words: 4 } }].map(frame => JSON.stringify(frame)).join('\n');
    response.write(frames.slice(0, 13)); setImmediate(() => response.end(frames.slice(13)));
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  const model = modelSchema.parse({ id: 'tts', name: '配音', provider: 'volcengine-tts', model: 'seed-tts-2.0', baseUrl: `http://127.0.0.1:${address.port}/api/v3`, capabilities: ['tts'], parameters: { voice: 'fixture-speaker', audio_params: { speech_rate: 20, sample_rate: '24000' } }, createdAt: '', updatedAt: '' });
  const result = await synthesizeVolcengineSpeech(model, 'fixture-key', '测试旁白', new AbortController().signal);
  expect(Buffer.from(result.base64, 'base64').toString()).toBe('audio-aaudio-b'); expect(result.providerUsage).toEqual({ source: 'provider', characters: 4 });
  expect(requests[0].headers).toMatchObject({ 'x-api-key': 'fixture-key', 'x-api-resource-id': 'seed-tts-2.0' });
  expect(requests[0].body).toEqual({ user: { uid: 'video-quickly' }, req_params: { text: '测试旁白', speaker: 'fixture-speaker', audio_params: { speech_rate: 20, sample_rate: 24000, format: 'mp3' } } });
  expect(() => validateModelParameters({ ...model, parameters: {} })).toThrow('配音音色');
  const legacy = volcengineSpeechHeaders({ ...model, parameters: { ...model.parameters, appId: 'fixture-app' } }, 'fixture-token');
  expect(legacy).toMatchObject({ 'X-Api-App-Id': 'fixture-app', 'X-Api-Access-Key': 'fixture-token' }); expect(legacy).not.toHaveProperty('X-Api-Key');
});

it.each([JSON.stringify({ code: 55000000 }), JSON.stringify({ code: 0, data: 'YQ==' })])('rejects provider errors and unfinished synthesis streams', async body => {
  const server = createServer((request, response) => { request.resume(); response.end(body); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('无测试端口');
  const model = modelSchema.parse({ id: 'tts', name: '配音', provider: 'volcengine-tts', model: 'seed-tts-2.0', baseUrl: `http://127.0.0.1:${address.port}`, capabilities: ['tts'], parameters: { voice: 'fixture-speaker' }, createdAt: '', updatedAt: '' });
  await expect(synthesizeVolcengineSpeech(model, 'fixture-key', '旁白', new AbortController().signal)).rejects.toThrow();
});
