import { MediaRequestRejectedError, retryAfterMilliseconds } from '@video-quickly/contracts';
import { z } from 'zod';
import type { MediaActivityContext } from './media-context.js';

export const objectSchema = z.record(z.string(), z.unknown());
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const rejectedPostStatuses = new Set([400, 401, 402, 403, 404, 405, 406, 410, 413, 414, 415, 422, 429]);
export const stringOrUndefined = (value: unknown) => typeof value === 'string' ? value : undefined;
export const nested = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => current && typeof current === 'object' ? Reflect.get(current, key) : undefined, value);

export async function boundedResponseBytes(response: Response, maximum = MAX_MEDIA_BYTES): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > maximum) { await response.body?.cancel(); throw new Error('素材结果超出单文件限制'); }
  if (!response.body) throw new Error('服务未返回素材内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('素材结果超出单文件限制'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function endpoint(base: string, path: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型地址须为不含内嵌凭据的 HTTP(S) 地址');
  return `${url.toString().replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function outputImageModerationRejected(response: Response): Promise<boolean> {
  let body: string;
  try { body = new TextDecoder().decode(await boundedResponseBytes(response, 8 * 1024)); }
  catch { return false; }
  let payload: unknown;
  try { payload = JSON.parse(body); }
  catch { payload = body; }
  const error = nested(payload, 'error') ?? payload;
  const code = stringOrUndefined(nested(error, 'code')) ?? '';
  const message = stringOrUndefined(nested(error, 'message') ?? error)?.trim() ?? '';
  // Some relays strip the Ark error code. Only retain a fixed local reason.
  return code === 'OutputImageSensitiveContentDetected' || code.startsWith('OutputImageSensitiveContentDetected.')
    || /^(?:status_code\s*=\s*400,\s*)?The request failed because the output image may contain sensitive information\b/i.test(message);
}

export async function requestJson(url: string, context: Pick<MediaActivityContext, 'apiKey' | 'node' | 'signal' | 'onDiagnostic'>, init: RequestInit = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const started = performance.now(), phase = init.method === 'POST' ? 'submit' : 'poll';
  const level = phase === 'poll' ? 'debug' : 'info';
  let statusCode: number | undefined;
  context.onDiagnostic?.({ event: 'media.request_started', level, phase });
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
    });
    statusCode = response.status;
    if (!response.ok) {
      const outputImageBlocked = phase === 'submit' && response.status === 400 && context.node.kind === 'assets'
        && await outputImageModerationRejected(response);
      if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
      if (phase === 'submit' && rejectedPostStatuses.has(response.status)) {
        throw new MediaRequestRejectedError(response.status, outputImageBlocked ? 'output-image-moderation' : undefined);
      }
      throw Object.assign(new Error(`模型请求未完成（HTTP ${response.status}），请检查服务配置`), { status: response.status, retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')) });
    }
    const bytes = await boundedResponseBytes(response, 64 * 1024 * 1024);
    const result = objectSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    context.onDiagnostic?.({ event: 'media.request_completed', level, phase, statusCode, byteSize: bytes.byteLength, durationMs: performance.now() - started });
    return result;
  } catch (error) {
    context.onDiagnostic?.({ event: 'media.request_failed', level: context.signal.aborted ? 'warn' : 'error', phase, statusCode, durationMs: performance.now() - started, error });
    throw error;
  }
}
