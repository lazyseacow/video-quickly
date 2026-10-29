import { requestModelParameters, type ModelProfile, type ProviderUsage } from '@video-quickly/contracts';

export interface TextGenerationRequest {
  model: ModelProfile;
  secret?: string;
  prompt: string;
  operationId: string;
  signal?: AbortSignal;
}

export interface TextGenerationResult { text: string; usage?: ProviderUsage }
export type TextProvider = (request: TextGenerationRequest) => Promise<string | TextGenerationResult>;

function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }

/** Only provider-reported counts are accepted; missing counters remain unknown. */
export function textProviderUsage(value: Record<string, unknown>, ollama: boolean): ProviderUsage | undefined {
  const raw = !ollama && value.usage && typeof value.usage === 'object' ? value.usage as Record<string, unknown> : {};
  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details as Record<string, unknown> : {};
  const measured = {
    inputTokens: count(ollama ? value.prompt_eval_count : raw.prompt_tokens),
    outputTokens: count(ollama ? value.eval_count : raw.completion_tokens),
    totalTokens: count(ollama ? undefined : raw.total_tokens),
    cachedInputTokens: count(ollama ? value.prompt_eval_cached_count : details.cached_tokens),
  };
  return Object.values(measured).some(value => value !== undefined) ? { source: 'provider', ...measured } : undefined;
}

function endpoint(base: string, route: string): string {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址须为不含账号密码的 HTTP 或 HTTPS 地址。');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${route}`;
  url.search = '';
  return url.toString();
}

function headers(secret?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
}

async function responseJson(response: Response): Promise<unknown> {
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('模型文本结果超过 4 MB，请缩小请求范围。'); }
  if (!response.body) throw new Error('模型未返回响应内容。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maximum) { await reader.cancel(); throw new Error('模型文本结果超过 4 MB，请缩小请求范围。'); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export const generateText: TextProvider = async ({ model, secret, prompt, operationId, signal }) => {
  const ollama = model.provider === 'ollama';
  const requestUrl = endpoint(model.baseUrl, ollama ? 'api/chat' : 'chat/completions');
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: { ...headers(secret), 'X-Client-Request-Id': operationId },
    body: JSON.stringify({
      ...requestModelParameters(model, 'text'),
      model: model.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}，请检查服务地址、模型及访问权限。`);
  const data = await responseJson(response);
  if (!data || typeof data !== 'object') throw new Error('模型服务返回了无效结果。');
  const value = data as Record<string, unknown>;
  const message = ollama ? value.message : Array.isArray(value.choices) ? (value.choices[0] as { message?: unknown } | undefined)?.message : undefined;
  if (!message || typeof message !== 'object') throw new Error('模型结果缺少消息内容。');
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回文本内容。');
  return { text: content, usage: textProviderUsage(value, ollama) };
};

export async function testModelConnection(model: ModelProfile, secret?: string) {
  const route = model.provider === 'ollama' ? 'api/tags' : model.provider === 'comfyui' ? 'system_stats' : 'models';
  const response = await fetch(endpoint(model.baseUrl, route), { headers: headers(secret), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`连接检查返回 HTTP ${response.status}。`);
  const data: unknown = await response.json();
  const entries = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const rows = model.provider === 'ollama' ? entries.models : entries.data;
  const modelIds = Array.isArray(rows) ? rows.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const identifier = record.id ?? record.name;
    return typeof identifier === 'string' ? [identifier] : [];
  }) : [];
  return { connected: true, models: modelIds, message: modelIds.includes(model.model) ? '连接正常，已找到配置的模型。' : '服务可连接，请确认模型 ID 与能力配置。' };
}
