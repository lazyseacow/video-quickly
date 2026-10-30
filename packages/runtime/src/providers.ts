import { requestModelParameters, textProtocols, validateModelParameters, type JsonValue, type ModelDiscovery, type ModelProfile, type ProviderUsage } from '@video-quickly/contracts';

export interface TextGenerationRequest {
  model: ModelProfile;
  secret?: string;
  prompt: string;
  operationId: string;
  signal?: AbortSignal;
}

export interface TextGenerationResult { text: string; usage?: ProviderUsage }
export type TextProvider = (request: TextGenerationRequest) => Promise<string | TextGenerationResult>;

export { providerReportedUsage as textProviderUsage } from '@video-quickly/contracts';
import { providerReportedUsage as textProviderUsage } from '@video-quickly/contracts';

export function modelEndpoint(base: string, route: string): string {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址须为不含账号密码的 HTTP 或 HTTPS 地址。');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${route}`;
  url.search = '';
  return url.toString();
}

function headers(secret?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
}

function modelHeaders(model: ModelProfile, secret?: string): Record<string, string> {
  return model.provider !== 'ollama' && model.capabilities.includes('text') && model.textProtocol === 'messages'
    ? { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(secret ? { 'x-api-key': secret } : {}) }
    : headers(secret);
}

export function textRequestParameters(model: ModelProfile): Record<string, JsonValue> {
  const parameters = requestModelParameters(model, 'text');
  if (model.provider === 'ollama') return parameters;
  const maximum = parameters.max_tokens ?? parameters.max_completion_tokens ?? parameters.max_output_tokens;
  if (model.textProtocol === 'responses' || model.textProtocol === 'messages') {
    delete parameters.max_tokens; delete parameters.max_completion_tokens; delete parameters.max_output_tokens;
    if (model.textProtocol === 'messages') parameters.max_tokens = maximum ?? 4096;
    else if (maximum !== undefined) parameters.max_output_tokens = maximum;
    const format = parameters.response_format;
    if (format && typeof format === 'object' && !Array.isArray(format)) {
      if (model.textProtocol === 'messages') {
        const json = format.json_schema;
        if (format.type !== 'json_schema' || !json || typeof json !== 'object' || Array.isArray(json) || !json.schema) throw new Error('Messages 的结构化输出请配置 json_schema 或原生 output_config。');
        parameters.output_config = { format: { type: 'json_schema', schema: json.schema } };
      } else {
        const json = format.json_schema;
        parameters.text = { format: format.type === 'json_schema' && json && typeof json === 'object' && !Array.isArray(json) ? { type: 'json_schema', ...json } : format };
      }
      delete parameters.response_format;
    }
  } else if (parameters.max_output_tokens !== undefined) {
    parameters.max_tokens = parameters.max_output_tokens; delete parameters.max_output_tokens;
  }
  return parameters;
}

function textBlocks(value: unknown, type: 'text' | 'output_text'): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap(block => block && typeof block === 'object' && block.type === type && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

export async function readModelResponse(response: Response): Promise<unknown> {
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
  const protocol = model.textProtocol ?? 'chat-completions';
  const requestUrl = modelEndpoint(model.baseUrl, ollama ? 'api/chat' : textProtocols.find(item => item.id === protocol)!.path);
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: { ...modelHeaders(model, secret), 'X-Client-Request-Id': operationId },
    body: JSON.stringify({
      ...(!ollama && protocol === 'responses' ? { store: false } : {}),
      ...textRequestParameters(model),
      model: model.model,
      ...(!ollama && protocol === 'responses' ? { input: [{ role: 'user', content: prompt }] } : { messages: [{ role: 'user', content: prompt }] }),
      stream: false,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}，请检查服务地址、模型及访问权限。`);
  const data = await readModelResponse(response);
  if (!data || typeof data !== 'object') throw new Error('模型服务返回了无效结果。');
  const value = data as Record<string, unknown>;
  if (!ollama && protocol === 'responses') {
    if (value.status === 'failed' || value.status === 'incomplete') throw new Error('Responses 未完整生成结果，请检查模型限制或提高最大输出 Token。');
    const text = Array.isArray(value.output) ? value.output.flatMap(item => item && typeof item === 'object' && item.type === 'message' ? [textBlocks(item.content, 'output_text')] : []).filter(Boolean).join('\n') : '';
    if (!text.trim()) throw new Error('模型未返回文本内容。');
    return { text, usage: textProviderUsage(value) };
  }
  if (!ollama && protocol === 'messages') {
    if (value.stop_reason === 'max_tokens') throw new Error('Messages 达到最大输出 Token，未完整生成结果。');
    const text = textBlocks(value.content, 'text');
    if (!text.trim()) throw new Error('模型未返回文本内容。');
    return { text, usage: textProviderUsage(value) };
  }
  const message = ollama ? value.message : Array.isArray(value.choices) ? (value.choices[0] as { message?: unknown } | undefined)?.message : undefined;
  if (!message || typeof message !== 'object') throw new Error('模型结果缺少消息内容。');
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回文本内容。');
  return { text: content, usage: textProviderUsage(value, ollama) };
};

export async function testModelConnection(model: ModelProfile, secret?: string) {
  if (model.provider === 'volcengine-tts' || model.provider === 'volcengine-asr') {
    validateModelParameters(model);
    if (!secret?.trim()) throw new Error('请先保存豆包语音 API Key 或 Access Token。');
    return { connected: false, models: [], message: '语音配置已核对，实际连接将在配音或识别任务中验证。' };
  }
  const route = model.provider === 'ollama' ? 'api/tags' : model.provider === 'comfyui' ? 'system_stats' : 'models';
  const response = await fetch(modelEndpoint(model.baseUrl, route), { headers: { ...modelHeaders(model, secret), ...(model.platform === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(secret ? { 'x-api-key': secret } : {}) } : {}) }, signal: AbortSignal.timeout(15_000) });
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

export async function discoverModels(model: ModelProfile, secret?: string): Promise<ModelDiscovery> {
  if (model.provider === 'volcengine-tts') return { source: 'preset', items: ['seed-tts-2.0', 'seed-tts-1.0', 'seed-tts-1.0-concurr', 'seed-icl-2.0', 'seed-icl-1.0', 'seed-icl-1.0-concurr'].map(id => ({ id, label: id })), message: '豆包语音资源预设；实际可用权限以控制台开通为准。请在配音参数中选择音色。' };
  if (model.provider === 'volcengine-asr') return { source: 'preset', items: [{ id: 'volc.bigasr.auc_turbo', label: '豆包语音识别 · 极速版' }], message: '语音识别资源预设，需在豆包语音控制台开通。' };
  if (model.provider === 'comfyui') return { source: 'workflow', items: [{ id: 'workflow', label: '使用工作流中的模型' }], message: 'ComfyUI 的模型由所配置工作流指定。' };
  const items = new Map<string, { id: string; label: string }>(); let after: string | undefined;
  const signal = AbortSignal.timeout(15_000);
  for (let page = 0; page < 20; page++) {
    const url = new URL(modelEndpoint(model.baseUrl, model.provider === 'ollama' ? 'api/tags' : 'models'));
    if (model.textProtocol === 'messages') { url.searchParams.set('limit', '1000'); if (after) url.searchParams.set('after_id', after); }
    const response = await fetch(url, { headers: { ...modelHeaders(model, secret), ...(model.platform === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(secret ? { 'x-api-key': secret } : {}) } : {}) }, signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`读取模型列表返回 HTTP ${response.status}`); }
    const data = await readModelResponse(response);
    if (!data || typeof data !== 'object') throw new Error('模型列表格式无效。');
    const value = data as Record<string, unknown>, rows = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : undefined;
    if (!rows) throw new Error('模型列表格式无效。');
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = row.id ?? row.name ?? row.model;
      if (typeof id !== 'string' || !id.trim() || id.length > 500) continue;
      const label = typeof row.display_name === 'string' ? row.display_name : typeof row.displayName === 'string' ? row.displayName : id;
      items.set(id, { id, label: label === id ? id : `${label} · ${id}` });
    }
    if (!value.has_more || typeof value.last_id !== 'string' || value.last_id === after) break;
    after = value.last_id;
  }
  return { source: 'remote', items: [...items.values()], message: items.size ? `已读取 ${items.size} 个模型；请选择与当前连接类型对应的专用型号。` : '服务未返回模型，可手动填写模型 ID。' };
}
