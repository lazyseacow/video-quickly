import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type CaptionTrack, type ModelProfile } from '@video-quickly/contracts';
import type { MediaActivityContext } from './index';
import { transcribeAudio } from './transcription';

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(error => { response.destroy(error instanceof Error ? error : undefined); }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务地址无效');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function fixture(baseUrl: string): Promise<MediaActivityContext> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'video-quickly-transcription-')); directories.push(dataDirectory);
  const bytes = Buffer.alloc(44 + 16_000 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const path = join(dataDirectory, 'voice.wav'); await writeFile(path, bytes);
  const now = new Date().toISOString();
  const audio: AssetRecord = { id: 'audio-1', projectId: 'project-1', name: 'voice.wav', path, kind: 'audio', mimeType: 'audio/wav', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: now, provenance: '测试录音', retained: false, active: true };
  const project = projectSchema.parse({ id: 'project-1', title: '字幕识别', brief: '记录真实语音时间戳', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), shots: [{ id: 'shot-1', title: '镜头一', narration: '识别提示词', visualPrompt: '', durationUs: 1_000_000, audioAssetId: audio.id }], createdAt: now, updatedAt: now });
  const model: ModelProfile = { id: 'asr-1', name: '时间戳模型', provider: 'openai-compatible', baseUrl, model: 'fixture-transcribe', capabilities: ['asr'], parameters: { language: 'zh' }, enabled: true, hasSecret: true, createdAt: now, updatedAt: now };
  return { project, node: { ...project.workflow.nodes.find(node => node.kind === 'voice')!, id: 'caption', modelId: model.id, config: { operation: 'transcribe', shotId: 'shot-1' } }, runId: 'run-1', operationId: 'run-1:caption', signal: new AbortController().signal, dataDirectory, assets: [audio], model, apiKey: 'fixture-auth', persistRemoteTask: vi.fn() };
}

async function multipart(request: IncomingMessage): Promise<FormData> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new Request('http://fixture.test', { method: 'POST', headers: { 'content-type': String(request.headers['content-type']) }, body: Buffer.concat(chunks) }).formData();
}

function track(output: unknown): CaptionTrack {
  expect(output).toMatchObject({ source: 'speech', shotId: 'shot-1' });
  if (!output || typeof output !== 'object' || !('captionTrack' in output)) throw new Error('未返回字幕轨道');
  return output.captionTrack as CaptionTrack;
}

it('posts actual multipart audio and preserves provider segment timestamps with a completed receipt', async () => {
  let calls = 0, form: FormData | undefined, authorization: string | undefined, operation: string | undefined;
  const baseUrl = await listen(async (request, response) => {
    calls++; expect(request.url).toBe('/v1/audio/transcriptions');
    authorization = request.headers.authorization; operation = String(request.headers['idempotency-key']); form = await multipart(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ duration: .9, usage: { type: 'duration', seconds: 1 }, segments: [{ start: .125, end: .4, text: ' 第一段 ' }, { start: .5, end: .9, text: '第二段' }] }));
  });
  const context = await fixture(baseUrl);
  const output = await transcribeAudio(context);
  expect(form?.get('model')).toBe('fixture-transcribe'); expect(form?.get('response_format')).toBe('verbose_json');
  expect(form?.get('timestamp_granularities[]')).toBe('segment'); expect(form?.get('language')).toBe('zh'); expect(form?.get('prompt')).toBe('识别提示词');
  const file = form?.get('file'); expect(file).toBeInstanceOf(File);
  expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(await readFile(context.assets[0].path));
  expect(authorization).toBe('Bearer fixture-auth'); expect(operation).toBe(context.operationId);
  expect(track(output)).toMatchObject({ timeBase: 'source', alignment: 'speech', sourceAssetId: 'audio-1', sourceSha256: context.assets[0].sha256, modelId: 'asr-1', granularity: 'segment', cues: [{ startUs: 125_000, endUs: 400_000, text: '第一段' }, { startUs: 500_000, endUs: 900_000, text: '第二段' }] });
  expect(output).toMatchObject({ providerUsage: { source: 'provider', audioSeconds: 1 } });
  expect(context.persistRemoteTask).toHaveBeenCalledWith(expect.stringMatching(/^transcription:/));
  expect(await transcribeAudio(context)).toEqual(output); expect(calls).toBe(1);
  expect((await readdir(join(context.dataDirectory, 'projects', context.project.id, 'transcriptions'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('supports real word timestamps and diarized segment responses without inventing timing', async () => {
  const forms: FormData[] = [];
  const baseUrl = await listen(async (request, response) => {
    forms.push(await multipart(request));
    response.end(JSON.stringify(forms.length === 1 ? { words: [{ start: .1, end: .2, word: '词' }] } : { segments: [{ start: .2, end: .8, text: '说话内容', speaker: 'speaker_1' }] }));
  });
  const context = await fixture(baseUrl); context.model!.parameters.timestampGranularity = 'word';
  expect(track(await transcribeAudio(context))).toMatchObject({ granularity: 'word', cues: [{ startUs: 100_000, endUs: 200_000, text: '词' }] });
  expect(forms[0].get('timestamp_granularities[]')).toBe('word');
  context.operationId = 'run-2:caption'; context.model!.parameters.asrResponseFormat = 'diarized_json'; context.model!.parameters.timestampGranularity = 'segment';
  expect(track(await transcribeAudio(context))).toMatchObject({ granularity: 'segment', cues: [{ startUs: 200_000, endUs: 800_000 }] });
  expect(forms[1].get('chunking_strategy')).toBe('auto'); expect(forms[1].has('timestamp_granularities[]')).toBe(false); expect(forms[1].has('prompt')).toBe(false);
});

it.each([
  ['plain text', JSON.stringify({ text: '没有时间戳的文字' }), '模型没有返回语音时间戳'],
  ['invalid JSON', '{broken', undefined],
  ['reversed timestamps', JSON.stringify({ segments: [{ start: .5, end: .1, text: '反向时间' }] }), undefined],
  ['overlapping timestamps', JSON.stringify({ segments: [{ start: 0, end: .6, text: '第一段' }, { start: .5, end: .9, text: '重叠段' }] }), undefined],
])('rejects %s and never automatically resubmits an ambiguous request', async (_name, body, message) => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { await multipart(request); calls++; response.end(body); });
  const context = await fixture(baseUrl);
  if (message) await expect(transcribeAudio(context)).rejects.toThrow(message); else await expect(transcribeAudio(context)).rejects.toThrow();
  await expect(transcribeAudio(context)).rejects.toThrow('上次字幕识别请求的结果尚未确认');
  expect(calls).toBe(1);
});

it('never resubmits after the provider connection disappears after upload', async () => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { await multipart(request); calls++; response.destroy(); });
  const context = await fixture(baseUrl);
  await expect(transcribeAudio(context)).rejects.toThrow();
  await expect(transcribeAudio(context)).rejects.toThrow('结果尚未确认');
  expect(calls).toBe(1);
});

it('reserves a submission exclusively when the same operation is invoked concurrently', async () => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { await multipart(request); calls++; response.end(JSON.stringify({ segments: [{ start: .1, end: .9, text: '一次识别' }] })); });
  const context = await fixture(baseUrl);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => transcribeAudio(context)));
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(calls).toBe(1);
});

it('refuses to reuse a completed receipt after its associated source hash changes', async () => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { await multipart(request); calls++; response.end(JSON.stringify({ segments: [{ start: 0, end: .9, text: '原音频' }] })); });
  const context = await fixture(baseUrl);
  await transcribeAudio(context);
  const replacement = Buffer.from('new source audio'); await writeFile(context.assets[0].path, replacement);
  context.assets[0] = { ...context.assets[0], sha256: createHash('sha256').update(replacement).digest('hex'), size: replacement.length, version: 2 };
  await expect(transcribeAudio(context)).rejects.toThrow('素材');
  expect(calls).toBe(1);
});

it('bounds chunked response bytes during reading and closes the oversized stream early', async () => {
  let sent = 0;
  const chunk = 'x'.repeat(100_000);
  const baseUrl = await listen(async (request, response) => {
    await multipart(request); response.setHeader('content-type', 'application/json');
    response.write('{"padding":"');
    const timer = setInterval(() => { sent += chunk.length; response.write(chunk); if (sent >= 20_000_000) { clearInterval(timer); response.end('"}'); } }, 2);
    response.on('close', () => clearInterval(timer));
  });
  const context = await fixture(baseUrl);
  await expect(transcribeAudio(context)).rejects.toThrow('结果过大');
  await vi.waitFor(() => expect(sent).toBeLessThan(8_000_000));
});
