import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requestModelParameters, type ModelProfile, type ProviderUsage } from '@video-quickly/contracts';

const frameSchema = z.object({ code: z.number(), data: z.string().nullable().optional(), usage: z.object({ text_words: z.number().nonnegative().optional() }).optional() });
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;

export function volcengineSpeechHeaders(model: ModelProfile, secret?: string): Record<string, string> {
  if (!secret?.trim()) throw new Error('请填写豆包语音 API Key；旧版控制台请填写 Access Token。');
  const appId = model.parameters.appId;
  return { 'Content-Type': 'application/json', 'X-Api-Resource-Id': model.model, 'X-Api-Request-Id': randomUUID(),
    ...(typeof appId === 'string' && appId.trim() ? { [model.provider === 'volcengine-asr' ? 'X-Api-App-Key' : 'X-Api-App-Id']: appId, 'X-Api-Access-Key': secret } : { 'X-Api-Key': secret }),
  };
}

function endpoint(base: string, path: string) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('豆包语音服务地址无效。');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`; url.search = ''; return url.toString();
}

export async function synthesizeVolcengineSpeech(model: ModelProfile, secret: string | undefined, text: string, signal: AbortSignal): Promise<{ base64: string; providerUsage?: ProviderUsage }> {
  const { voice, appId: _, audio_params: audio, ...parameters } = requestModelParameters(model, 'tts');
  const options = audio && typeof audio === 'object' && !Array.isArray(audio) ? audio : {};
  const response = await fetch(endpoint(model.baseUrl, 'tts/unidirectional'), { method: 'POST', headers: volcengineSpeechHeaders(model, secret),
    body: JSON.stringify({ user: { uid: 'video-quickly' }, req_params: { ...parameters, text, speaker: voice, audio_params: { ...options, format: 'mp3', sample_rate: Number(options.sample_rate ?? 24000) } } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`豆包语音合成失败（HTTP ${response.status}）。`); }
  if (!response.body) throw new Error('豆包语音未返回音频。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const chunks: Buffer[] = []; let pending = '', transportSize = 0, audioSize = 0, completed = false, providerUsage: ProviderUsage | undefined;
  function frame(line: string) {
    if (!line.trim()) return;
    const value = frameSchema.parse(JSON.parse(line));
    if (value.code !== 0 && value.code !== 20000000) throw new Error(`豆包语音返回错误码 ${value.code}，请核对资源 ID、音色和服务权限。`);
    if (value.data) {
      const bytes = Buffer.from(value.data, 'base64'); audioSize += bytes.length;
      if (audioSize > MAX_AUDIO_BYTES) throw new Error('豆包语音音频超出 128 MB 限制。');
      chunks.push(bytes);
    }
    if (value.code === 20000000) { completed = true; if (value.usage?.text_words !== undefined) providerUsage = { source: 'provider', characters: value.usage.text_words }; }
  }
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      transportSize += next.value.byteLength; if (transportSize > MAX_AUDIO_BYTES * 2) throw new Error('豆包语音响应过大。');
      pending += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) { frame(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
    }
    frame(pending + decoder.decode());
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  if (!completed || !audioSize) throw new Error('豆包语音未完整生成音频，请核对服务端任务后重试。');
  return { base64: Buffer.concat(chunks, audioSize).toString('base64'), providerUsage };
}

export function volcengineRecognitionRequest(model: ModelProfile, secret: string | undefined, audio: Uint8Array, signal: AbortSignal) {
  const { appId: _, timestampGranularity: __, ...parameters } = requestModelParameters(model, 'asr');
  return { url: endpoint(model.baseUrl, 'auc/bigmodel/recognize/flash'), init: {
    method: 'POST', headers: { ...volcengineSpeechHeaders(model, secret), 'X-Api-Sequence': '-1' },
    body: JSON.stringify({ user: { uid: 'video-quickly' }, audio: { data: Buffer.from(audio).toString('base64') }, request: { ...parameters, model_name: 'bigmodel', show_utterances: true } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  } };
}

const wordSchema = z.object({ start_time: z.number().finite().nonnegative(), end_time: z.number().finite().positive(), text: z.string() });
const transcriptSchema = z.object({ audio_info: z.object({ duration: z.number().nonnegative() }).optional(), result: z.object({ utterances: z.array(wordSchema.extend({ words: z.array(wordSchema).optional() })).optional() }), usage: z.unknown().optional() });
export function normalizeVolcengineTranscript(value: unknown) {
  const parsed = transcriptSchema.parse(value), utterances = parsed.result.utterances;
  return { duration: parsed.audio_info ? parsed.audio_info.duration / 1000 : undefined, usage: parsed.usage,
    segments: utterances?.map(segment => ({ start: segment.start_time / 1000, end: segment.end_time / 1000, text: segment.text })),
    words: utterances?.length && utterances.every(segment => segment.words?.length) ? utterances.flatMap(segment => segment.words!.map(word => ({ start: word.start_time / 1000, end: word.end_time / 1000, word: word.text }))) : undefined,
  };
}
