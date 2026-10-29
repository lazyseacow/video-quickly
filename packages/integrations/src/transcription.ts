import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { captionTrackSchema, providerUsageSchema, requestModelParameters, TranscriptionTimestampError, type CaptionTrack, type JsonValue, type ProviderUsage } from '@video-quickly/contracts';
import type { MediaActivityContext } from './index.js';

const timedSegmentSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string() });
const responseSchema = z.object({
  segments: z.array(timedSegmentSchema).optional(),
  words: z.array(timedSegmentSchema.omit({ text: true }).extend({ word: z.string() })).optional(),
  duration: z.unknown().optional(), usage: z.unknown().optional(),
});
const receiptSchema = z.object({ state: z.enum(['submitted', 'completed']), track: captionTrackSchema.optional(), providerUsage: providerUsageSchema.optional() });
const MAX_RESPONSE_BYTES = 4_000_000;

async function responseText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error('字幕识别结果过大。'); }
  if (!response.body) throw new Error('字幕识别未返回结果。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('字幕识别结果过大。'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** Actual provider timestamps are required; plain text never becomes a speech-aligned track. */
export async function transcribeAudio(context: MediaActivityContext): Promise<JsonValue> {
  const shot = context.project.shots.find(shot => shot.id === context.node.config.shotId);
  const audio = context.assets.find(asset => asset.id === shot?.audioAssetId && asset.active && asset.kind === 'audio');
  const model = context.model;
  if (!shot || !audio) throw new Error('请先为当前镜头关联旁白音频。');
  if (!model?.enabled || !model.capabilities.includes('asr') || model.provider !== 'openai-compatible') throw new Error('字幕识别需要支持时间戳的 OpenAI 兼容 ASR 模型。');
  const info = await stat(audio.path);
  if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('当前字幕识别支持不超过 25 MB 的音频文件，请先裁出需要识别的音频。');
  const bytes = await readFile(audio.path);
  if (createHash('sha256').update(bytes).digest('hex') !== audio.sha256) throw new Error('音频素材校验失败，请重新导入后识别。');
  context.signal.throwIfAborted();
  const directory = join(context.dataDirectory, 'projects', context.project.id, 'transcriptions');
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(context.operationId).digest('hex');
  const path = join(directory, `${key}.json`);
  async function save(value: z.infer<typeof receiptSchema>) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value)); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  let receipt: z.infer<typeof receiptSchema> | undefined;
  try { receipt = receiptSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const output = (track: CaptionTrack, usage?: ProviderUsage): JsonValue => ({ shotId: shot.id, source: 'speech', captionTrack: track as unknown as JsonValue, ...(usage ? { providerUsage: usage as unknown as JsonValue } : {}) });
  if (receipt?.state === 'completed' && receipt.track) {
    if (receipt.track.alignment !== 'speech' || receipt.track.sourceAssetId !== audio.id || receipt.track.sourceSha256 !== audio.sha256 || receipt.track.modelId !== model.id) throw new Error('已完成的字幕识别与当前素材或模型不一致，请创建新的识别任务。');
    return output(receipt.track, receipt.providerUsage);
  }
  if (receipt) throw new Error('上次字幕识别请求的结果尚未确认，请核对服务端记录后显式重新识别。');

  const base = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('字幕模型服务地址无效。');
  const url = `${base.toString().replace(/\/$/, '')}/audio/transcriptions`;
  const parameters = requestModelParameters(model, 'asr');
  const granularity = parameters.timestampGranularity === 'word' ? 'word' : 'segment';
  const format = parameters.asrResponseFormat === 'diarized_json' ? 'diarized_json' : 'verbose_json';
  const body = new FormData();
  for (const [key, value] of Object.entries(parameters)) {
    if (['file', 'model', 'response_format', 'timestamp_granularities[]', 'timestampGranularity', 'asrResponseFormat', 'prompt'].includes(key)) continue;
    if (Array.isArray(value)) for (const item of value) body.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
    else body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  body.set('file', new Blob([bytes], { type: audio.mimeType }), basename(audio.path));
  body.set('model', model.model); body.set('response_format', format);
  if (format === 'verbose_json') body.set('timestamp_granularities[]', granularity);
  else body.set('chunking_strategy', 'auto');
  const prompt = typeof parameters.prompt === 'string' ? parameters.prompt : shot.narration;
  if (prompt.trim() && format === 'verbose_json') body.set('prompt', prompt.slice(0, 5000));
  // Exclusive reservation also covers simultaneous callers with the same operation ID.
  // A partial file after a process failure remains ambiguous and can never trigger resubmission.
  try { await writeFile(path, JSON.stringify({ state: 'submitted' }), { flag: 'wx' }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('上次字幕识别请求的结果尚未确认，请核对服务端记录后显式重新识别。');
    throw error;
  }
  // This local receipt permits recovery to inspect an existing result, never an automatic resubmission.
  context.persistRemoteTask(`transcription:${key}`);
  const response = await fetch(url, {
    method: 'POST', body,
    headers: { ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), 'Idempotency-Key': context.operationId },
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`字幕识别失败（HTTP ${response.status}），请检查服务配置。`); }
  const text = await responseText(response);
  const parsed = responseSchema.parse(JSON.parse(text));
  const rawUsage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : {};
  const number = (value: unknown, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
  const measured = { inputTokens: number(rawUsage.input_tokens, true), outputTokens: number(rawUsage.output_tokens, true), totalTokens: number(rawUsage.total_tokens, true), audioSeconds: number(rawUsage.seconds) ?? number(parsed.duration) };
  const usage: ProviderUsage | undefined = Object.values(measured).some(value => value !== undefined) ? { source: 'provider', ...measured } : undefined;
  const words = parsed.words?.map(word => ({ start: word.start, end: word.end, text: word.word }));
  const segments = granularity === 'word' && words ? words : parsed.segments ?? words;
  if (!segments) throw new TranscriptionTimestampError();
  const track = captionTrackSchema.parse({
    timeBase: 'source', alignment: 'speech', sourceAssetId: audio.id, sourceSha256: audio.sha256, modelId: model.id,
    granularity: segments === words ? 'word' : 'segment',
    cues: segments.filter(segment => segment.text.trim()).map((segment, index) => ({ id: `${key}-${index}`, startUs: Math.round(segment.start * 1_000_000), endUs: Math.round(segment.end * 1_000_000), text: segment.text.trim() })),
  });
  await save({ state: 'completed', track, providerUsage: usage });
  return output(track, usage);
}
