import type { ModelProfile } from '@video-quickly/contracts';

export interface TextGenerationRequest {
  model: ModelProfile;
  secret?: string;
  prompt: string;
  operationId: string;
  signal?: AbortSignal;
}

export type TextProvider = (request: TextGenerationRequest) => Promise<string>;

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

export const generateText: TextProvider = async ({ model, secret, prompt, operationId, signal }) => {
  const ollama = model.provider === 'ollama';
  const requestUrl = endpoint(model.baseUrl, ollama ? 'api/chat' : 'chat/completions');
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: { ...headers(secret), 'X-Client-Request-Id': operationId },
    body: JSON.stringify({
      ...model.parameters,
      model: model.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}，请检查服务地址、模型及访问权限。`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object') throw new Error('模型服务返回了无效结果。');
  const value = data as Record<string, unknown>;
  const message = ollama ? value.message : Array.isArray(value.choices) ? (value.choices[0] as { message?: unknown } | undefined)?.message : undefined;
  if (!message || typeof message !== 'object') throw new Error('模型结果缺少消息内容。');
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回文本内容。');
  return content;
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
