import { getModelConnectionType, modelParameterValue, requestModelParameters, textProtocols, withModelParameter, type JsonValue, type ModelCapability, type ModelConnectionType, type ModelDiscovery, type ModelProfile, type ProviderUsage } from '@video-quickly/contracts';
import { z } from 'zod';

export type ModelRequestPhase = 'prepare' | 'send' | 'headers' | 'read' | 'parse' | 'validate';

export interface TextGenerationRequest {
  model: ModelProfile;
  secret?: string;
  prompt: string;
  operationId: string;
  signal?: AbortSignal;
  onRequestPhase?: (phase: ModelRequestPhase) => void;
  outputSchema?: Record<string, unknown>;
  outputSchemaName?: string;
  promptOutputFormat?: boolean;
  onOutputFormatFallback?: () => void;
}

export const textIncompleteReasonSchema = z.enum(['max_output_tokens', 'content_filter', 'provider_failed', 'unknown']);
type TextIncompleteReason = z.infer<typeof textIncompleteReasonSchema>;
export interface TextGenerationResult { text: string; usage?: ProviderUsage; incomplete?: boolean; incompleteReason?: TextIncompleteReason }
export type TextProvider = (request: TextGenerationRequest) => Promise<string | TextGenerationResult>;

export function textIncompleteMessage(reason: TextIncompleteReason, output?: 'storyboard' | 'document'): string {
  switch (reason) {
    case 'max_output_tokens': {
      if (!output) return '模型输出达到 Token 上限。请在「模型连接」检查最大输出 Token 后重试。';
      const shorter = output === 'storyboard' ? '在创作要求中减少镜头数量' : '缩短正文要求';
      return `模型输出被截断，已达到 Token 上限。请在「模型连接」提高最大输出 Token，或${shorter}，然后重新开始制作。`;
    }
    case 'content_filter': return '模型服务因内容限制中止生成。请调整创作要求后重新开始制作。';
    case 'provider_failed': return '模型服务返回生成失败。请重试当前步骤。';
    case 'unknown': return '模型未完整生成结果，具体原因未知。请重试当前步骤。';
  }
}

/** An explicit request rejection is distinct from an unconfirmed submission. */
export class TextRequestRejectedError extends Error {
  constructor(readonly status: number, readonly unsupportedOutputFormat = false) {
    super(unsupportedOutputFormat ? `模型服务不支持本次输出格式（HTTP ${status}），请求已被拒绝。` : `模型服务已拒绝请求（HTTP ${status}），请核对请求参数、模型及访问权限。`);
    this.name = 'TextRequestRejectedError';
  }
}

const rejectedTextStatuses = new Set([400, 401, 402, 403, 404, 405, 406, 410, 413, 414, 415, 422, 429]);
function hasConfiguredOutputFormat(parameters: Record<string, JsonValue>) { return Boolean(parameters.response_format || parameters.format || parameters.output_config || parameters.text); }
function usesAutomaticOutputFormat(model: ModelProfile) {
  return model.capabilities.includes('structured-output') && !hasConfiguredOutputFormat(model.parameters);
}

export function shouldRetryWithPromptFormat(model: ModelProfile, previous?: TextGenerationResult) {
  return model.provider !== 'ollama' && model.textProtocol === 'responses' && usesAutomaticOutputFormat(model)
    && previous?.incomplete === true && previous.incompleteReason === 'unknown' && !previous.text.trim();
}

function unsupportedOutputFormat(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>, detail = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : body;
  const description = [detail.param, detail.code, detail.message, detail.type, typeof body.error === 'string' ? body.error : ''].filter(item => typeof item === 'string').join(' ');
  return /text[.\s_]+format|response_format|json_schema|output_config|structured[\s_-]*outputs?/i.test(description)
    && /unsupported|not supported|does not support|not support|not allowed|not permitted|unrecognized|unknown (?:parameter|field)|extra (?:fields|inputs)|不支持/i.test(description);
}
function maasRequestFormatRejection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('error' in value) || !value.error || typeof value.error !== 'object') return false;
  const error = value.error as Record<string, unknown>;
  return error.code === '400001' && error.type === 'invalid_request_error' && typeof error.message === 'string' && /rejected by an internal MaaS component/i.test(error.message);
}

export { providerReportedUsage as textProviderUsage } from '@video-quickly/contracts';
import { providerReportedUsage as textProviderUsage } from '@video-quickly/contracts';

function modelEndpoint(base: string, route: string): string {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址须为不含账号密码的 HTTP 或 HTTPS 地址。');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${route}`;
  url.search = '';
  return url.toString();
}

export async function fetchModelRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let request = new Request(input, { ...init, redirect: 'manual' });
  const origin = new URL(request.url).origin;
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(request.clone());
    const location = response.headers.get('location');
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const target = new URL(location, request.url);
    if (target.origin !== origin || target.username || target.password) throw new Error('模型服务重定向到了其他来源，请直接配置目标服务地址。');
    if (redirects >= 4) throw new Error('模型服务重定向次数过多。');
    const toGet = [301, 302].includes(response.status) && request.method === 'POST'
      || response.status === 303 && !['GET', 'HEAD'].includes(request.method);
    if (toGet) {
      const headers = new Headers(request.headers);
      for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      request = new Request(target, { headers, signal: request.signal, redirect: 'manual' });
    } else request = new Request(target, request);
  }
}

export function textModelEndpoint(model: ModelProfile): string {
  if (model.fullUrl) return model.baseUrl;
  const route = model.provider === 'ollama' ? 'api/chat' : textProtocols.find(item => item.id === (model.textProtocol ?? 'chat-completions'))!.path;
  return modelEndpoint(model.baseUrl, route);
}

export function modelHeaders(model: ModelProfile, secret?: string): Record<string, string> {
  const messages = model.provider === 'openai-compatible' && model.connectionType === 'text' && model.textProtocol === 'messages';
  const auth = model.authMode === 'bearer' || model.authMode === 'x-api-key' ? model.authMode : messages ? 'x-api-key' : 'bearer';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (messages) headers['anthropic-version'] = '2023-06-01';
  if (secret) {
    if (auth === 'x-api-key') headers['x-api-key'] = secret;
    else headers.Authorization = `Bearer ${secret}`;
  }
  return headers;
}

export function textRequestParameters(model: ModelProfile, outputSchema?: Record<string, unknown>, outputSchemaName = 'video_storyboard'): Record<string, JsonValue> {
  const parameters = requestModelParameters(model, 'text');
  if (outputSchema && model.capabilities.includes('structured-output') && !hasConfiguredOutputFormat(parameters)) {
    if (model.provider === 'ollama') parameters.format = outputSchema as JsonValue;
    else if (model.textProtocol === 'messages') parameters.output_config = { format: { type: 'json_schema', schema: outputSchema as JsonValue } };
    else if (model.textProtocol === 'responses') parameters.response_format = { type: 'json_schema', json_schema: { name: outputSchemaName, schema: outputSchema as JsonValue, strict: false } };
    else parameters.response_format = { type: 'json_object' };
  }
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

/** A phased task supplies its own schema even when the connection pins a JSON schema. */
export function textModelWithTaskSchema(model: ModelProfile, outputSchema: Record<string, unknown>, name: string): ModelProfile {
  const { parameters } = model, schema = outputSchema as JsonValue;
  if (model.provider === 'ollama') {
    const format = parameters.format;
    return format && typeof format === 'object' && !Array.isArray(format) ? { ...model, parameters: { ...parameters, format: schema } } : model;
  }
  if (modelParameterValue(parameters, 'response_format.type') === 'json_schema') {
    return { ...model, parameters: { ...parameters, response_format: { type: 'json_schema', json_schema: { name, schema, strict: false } } } };
  }
  if (model.textProtocol === 'responses' && modelParameterValue(parameters, 'text.format.type') === 'json_schema') {
    return { ...model, parameters: withModelParameter(parameters, 'text.format', { type: 'json_schema', name, schema, strict: false }) };
  }
  if (model.textProtocol === 'messages' && modelParameterValue(parameters, 'output_config.format.type') === 'json_schema') {
    return { ...model, parameters: withModelParameter(parameters, 'output_config.format', { type: 'json_schema', schema }) };
  }
  return model;
}

function textBlocks(value: unknown, type: 'text' | 'output_text'): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap(block => block && typeof block === 'object' && block.type === type && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

function responsesIncompleteReason(value: Record<string, unknown>): TextIncompleteReason | undefined {
  if (value.status === 'failed') return 'provider_failed';
  if (value.status !== 'incomplete') return undefined;
  const details = value.incomplete_details;
  const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
  return reason === 'max_output_tokens' || reason === 'content_filter' ? reason : 'unknown';
}

export async function readModelResponse(response: Response, onRequestPhase?: TextGenerationRequest['onRequestPhase']): Promise<unknown> {
  onRequestPhase?.('read');
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('模型文本结果超过 4 MB，请缩小请求范围。'); }
  if (!response.body) throw new Error('模型未返回响应内容。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maximum) { await reader.cancel(); throw new Error('模型文本结果超过 4 MB，请缩小请求范围。'); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks, size).toString('utf8');
  onRequestPhase?.('parse');
  return JSON.parse(text);
}

export const generateText: TextProvider = async ({ model, secret, prompt, operationId, signal, onRequestPhase, outputSchema, outputSchemaName, promptOutputFormat, onOutputFormatFallback }) => {
  onRequestPhase?.('prepare');
  const ollama = model.provider === 'ollama';
  const protocol = model.textProtocol ?? 'chat-completions';
  const requestUrl = textModelEndpoint(model);
  const parameters = textRequestParameters(model, promptOutputFormat ? undefined : outputSchema, outputSchemaName);
  const automaticFormat = Boolean(outputSchema && !promptOutputFormat && usesAutomaticOutputFormat(model));
  const body = {
    ...(!ollama && protocol === 'responses' ? { store: false } : {}), model: model.model,
    ...(!ollama && protocol === 'responses' ? { input: [{ role: 'user', content: prompt }] } : { messages: [{ role: 'user', content: prompt }] }), stream: false,
  };
  const request = {
    method: 'POST',
    headers: { ...modelHeaders(model, secret), 'X-Client-Request-Id': operationId },
    body: JSON.stringify({ ...parameters, ...body }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  };
  onRequestPhase?.('send');
  let response = await fetchModelRequest(requestUrl, request);
  onRequestPhase?.('headers');
  if (!response.ok) {
    const status = response.status;
    let formatRejected = false, maasFormatProbe = false;
    if (status === 400 || status === 422) {
      try {
        const errorBody = await readModelResponse(response);
        formatRejected = unsupportedOutputFormat(errorBody);
        maasFormatProbe = status === 400 && protocol === 'responses' && maasRequestFormatRejection(errorBody);
      }
      catch { /* The explicit HTTP rejection remains known even without a readable error body. */ }
    } else await response.body?.cancel();
    if (automaticFormat && (formatRejected || maasFormatProbe)) {
      // MaaS can reject Responses JSON Schema with generic 400001 and no param.
      // Probe without our automatic format only after an explicit rejection.
      // Keep the same prompt and frozen model; never replay an uncertain request.
      onOutputFormatFallback?.();
      request.headers['X-Client-Request-Id'] = `${operationId}:prompt-format`;
      request.body = JSON.stringify({ ...textRequestParameters(model), ...body });
      onRequestPhase?.('send'); response = await fetchModelRequest(requestUrl, request); onRequestPhase?.('headers');
    } else {
      if (rejectedTextStatuses.has(status)) throw new TextRequestRejectedError(status, formatRejected);
      throw Object.assign(new Error(`模型服务返回 HTTP ${status}，请检查服务地址、模型及访问权限。`), { status });
    }
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (rejectedTextStatuses.has(response.status)) throw new TextRequestRejectedError(response.status);
    throw Object.assign(new Error(`模型服务返回 HTTP ${response.status}，请检查服务地址、模型及访问权限。`), { status: response.status });
  }
  const data = await readModelResponse(response, onRequestPhase);
  onRequestPhase?.('validate');
  if (!data || typeof data !== 'object') throw new Error('模型服务返回了无效结果。');
  const value = data as Record<string, unknown>;
  if (!ollama && protocol === 'responses') {
    const incompleteReason = responsesIncompleteReason(value);
    if (incompleteReason && !outputSchema) throw new Error(textIncompleteMessage(incompleteReason));
    const text = Array.isArray(value.output) ? value.output.flatMap(item => item && typeof item === 'object' && item.type === 'message' ? [textBlocks(item.content, 'output_text')] : []).filter(Boolean).join('\n') : '';
    if (!text.trim() && !outputSchema) throw new Error('模型未返回文本内容。');
    return { text, usage: textProviderUsage(value), ...(incompleteReason ? { incomplete: true, incompleteReason } : {}) };
  }
  if (!ollama && protocol === 'messages') {
    const incomplete = value.stop_reason === 'max_tokens';
    if (incomplete && !outputSchema) throw new Error('Messages 达到最大输出 Token，未完整生成结果。');
    const text = textBlocks(value.content, 'text');
    if (!text.trim() && !outputSchema) throw new Error('模型未返回文本内容。');
    return { text, usage: textProviderUsage(value), ...(incomplete ? { incomplete: true, incompleteReason: 'max_output_tokens' } : {}) };
  }
  const message = ollama ? value.message : Array.isArray(value.choices) ? (value.choices[0] as { message?: unknown } | undefined)?.message : undefined;
  if (!message || typeof message !== 'object') throw new Error('模型结果缺少消息内容。');
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || (!content.trim() && !outputSchema)) throw new Error('模型未返回文本内容。');
  const incomplete = ollama ? value.done_reason === 'length' : (value.choices as { finish_reason?: string }[])[0]?.finish_reason === 'length';
  return { text: content, usage: textProviderUsage(value, ollama), ...(incomplete ? { incomplete: true, incompleteReason: 'max_output_tokens' } : {}) };
};

export async function testModelConnection(model: ModelProfile, secret?: string) {
  const headers = modelHeaders(model, secret), signal = AbortSignal.timeout(15_000);
  if (model.fullUrl) {
    const response = await fetchModelRequest(textModelEndpoint(model), { method: 'HEAD', headers, signal });
    if (!response.ok && response.status !== 405) throw Object.assign(new Error(`连接检查返回 HTTP ${response.status}。`), { status: response.status });
    return { connected: true, models: [], message: '服务地址可访问。可通过一次生成确认模型和参数。' };
  }
  const route = model.provider === 'ollama' ? 'api/tags' : model.provider === 'comfyui' ? 'system_stats' : 'models';
  const response = await fetchModelRequest(modelEndpoint(model.baseUrl, route), { headers, signal });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`连接检查返回 HTTP ${response.status}。`), { status: response.status }); }
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

function discoveredModelTime(row: Record<string, unknown>): number {
  for (const value of [row.created, row.created_at, row.modified_at, row.published_time]) {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    // Endpoints use Unix seconds/milliseconds or date strings (including
    // Qwen's published_time). Normalize them before merging all pages.
    let timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(numeric)) timestamp = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function matchesOpenAIConnection(id: string, model: ModelProfile): boolean {
  // OpenAI's model list has no modality field. Classify known families by their
  // base model ID; fine-tuning organization and suffix names are not modalities.
  const baseId = id.startsWith('ft:') ? id.split(':')[1] ?? '' : id;
  const connectionType = getModelConnectionType(model);
  if (connectionType === 'image') return /^(?:gpt-image|chatgpt-image|dall-e)(?:-|$)/.test(baseId);
  if (connectionType === 'video') return false;

  return /^(?:gpt-|chatgpt-|o\d+(?:-|$)|codex-)/.test(baseId)
    && !/(?:^|-)(?:audio|realtime|live|image|transcribe|tts)(?:-|$)/.test(baseId);
}

const arkCatalogMetadata = z.object({
  domain: z.string().optional(),
  modalities: z.object({ input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() }).optional(),
  features: z.object({
    tools: z.object({ function_calling: z.boolean().optional() }).optional(),
    structured_outputs: z.object({ json_object: z.boolean().optional(), json_schema: z.boolean().optional() }).optional(),
  }).optional(),
});
const arkOutputByDomain: Record<string, string> = {
  LLM: 'text', VLM: 'text', ImageGeneration: 'image', VideoGeneration: 'video', '3DGeneration': '3D', Audio: 'audio', Embedding: 'embedding',
};

function arkCatalogCapabilities(row: Record<string, unknown>, type: ModelConnectionType, protocol?: ModelProfile['textProtocol']): ModelCapability[] | false | undefined {
  const parsed = arkCatalogMetadata.safeParse(row);
  if (!parsed.success) return;
  const { domain, modalities, features } = parsed.data;
  const outputs = modalities?.output_modalities;
  const domainOutput = domain && arkOutputByDomain[domain];
  if (outputs?.length ? !outputs.includes(type) : domainOutput && domainOutput !== type) return false;
  if (type !== 'text') return;
  const capabilities: ModelCapability[] = ['text'];
  if (modalities?.input_modalities?.includes('image')) capabilities.push('vision');
  if (features?.tools?.function_calling) capabilities.push('tools');
  if (protocol === 'responses' || protocol === 'messages' ? features?.structured_outputs?.json_schema : features?.structured_outputs?.json_object) capabilities.push('structured-output');
  return capabilities;
}

export async function discoverModels(model: ModelProfile, secret?: string): Promise<ModelDiscovery> {
  if (model.provider === 'comfyui') return { source: 'workflow', items: [{ id: 'workflow', label: '使用工作流中的模型' }], message: 'ComfyUI 的模型由所配置工作流指定。' };
  if (model.fullUrl) return { source: 'remote', items: [], message: '完整请求地址使用手动填写的模型 ID。' };
  const host = new URL(model.baseUrl).hostname;
  const filterOpenAI = model.provider === 'openai-compatible' && (model.platform === 'openai' || host === 'api.openai.com');
  const filterArk = ['volcengine', 'seedream', 'seedance'].some(platform => platform === model.platform || platform === model.provider)
    || host.endsWith('.volces.com') && host.startsWith('ark.');
  const items = new Map<string, ModelDiscovery['items'][number] & { timestamp: number; retired: boolean }>();
  let after: string | undefined;
  const signal = AbortSignal.timeout(15_000);
  for (let page = 0; page < 20; page++) {
    const url = new URL(modelEndpoint(model.baseUrl, model.provider === 'ollama' ? 'api/tags' : 'models'));
    if (model.textProtocol === 'messages') { url.searchParams.set('limit', '1000'); if (after) url.searchParams.set('after_id', after); }
    const response = await fetchModelRequest(url, { headers: modelHeaders(model, secret), signal });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('读取模型列表返回 HTTP ' + response.status), { status: response.status }); }
    const data = await readModelResponse(response);
    if (!data || typeof data !== 'object') throw new Error('模型列表格式无效。');
    const value = data as Record<string, unknown>, rows = Array.isArray(value.data) ? value.data : value.models;
    if (!Array.isArray(rows)) throw new Error('模型列表格式无效。');
    for (const entry of rows) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>, id = row.id ?? row.name ?? row.model;
      if (typeof id !== 'string' || !id.trim() || id.length > 200 || filterOpenAI && !matchesOpenAIConnection(id, model)) continue;
      const capabilities = filterArk ? arkCatalogCapabilities(row, model.connectionType, model.textProtocol) : undefined;
      if (capabilities === false) continue;
      const name = typeof row.display_name === 'string' ? row.display_name : typeof row.displayName === 'string' ? row.displayName : id;
      const shutdown = typeof row.shutdown_date === 'string' ? Date.parse(row.shutdown_date) : NaN;
      items.set(id, { id, label: name === id ? id : name + ' · ' + id, ...(capabilities ? { capabilities } : {}), timestamp: Math.max(discoveredModelTime(row), items.get(id)?.timestamp ?? Number.NEGATIVE_INFINITY), retired: row.lifecycle === 'retired' || Number.isFinite(shutdown) && shutdown <= Date.now() });
    }
    if (!value.has_more) break;
    if (typeof value.last_id !== 'string' || value.last_id === after || page === 19) throw new Error('模型列表分页不完整，请重新读取完整目录。');
    after = value.last_id;
  }
  const sorted = [...items.values()].filter(item => !item.retired).sort((a, b) => a.timestamp === b.timestamp ? 0 : b.timestamp - a.timestamp)
    .map(({ id, label, capabilities }) => ({ id, label, ...(capabilities ? { capabilities } : {}) }));
  const guidance = filterOpenAI ? '已按当前连接类型筛选。' : '请选择与当前连接类型对应的型号。';
  return { source: 'remote', items: sorted, message: sorted.length ? `已读取 ${sorted.length} 个模型。${guidance}` : '服务未返回适合当前连接类型的模型。可手动填写模型 ID，或核对连接后重试。' };
}
