import type { JsonValue, ModelCapability, ModelProfile } from './index.js';

export type ModelParameterOperation = 'text' | 'image' | 'video' | 'tts' | 'asr';
export interface ModelParameterField {
  key: string; label: string; operation: ModelParameterOperation; type: 'text' | 'number' | 'select';
  min?: number; max?: number; integer?: boolean; options?: readonly string[]; hint?: string; customSize?: boolean; required?: boolean;
}
type Context = Pick<ModelProfile, 'provider' | 'capabilities' | 'textProtocol'>;
type WithParameters = Context & { parameters: Record<string, JsonValue> };

export function getModelParameterFields(model: Context): ModelParameterField[] {
  const fields: ModelParameterField[] = [];
  const has = (capability: ModelCapability) => model.capabilities.includes(capability);
  if (has('text')) {
    const ollama = model.provider === 'ollama';
    fields.push({ key: ollama ? 'options.temperature' : 'temperature', label: '文本温度', operation: 'text', type: 'number', min: 0, ...(ollama ? {} : { max: model.textProtocol === 'messages' ? 1 : 2 }) },
      { key: ollama ? 'options.num_predict' : model.textProtocol === 'responses' ? 'max_output_tokens' : 'max_tokens', label: '最大输出 Token', operation: 'text', type: 'number', min: !ollama && model.textProtocol === 'responses' ? 16 : 1, integer: true });
  }
  if (has('image') && ['openai-compatible', 'seedream'].includes(model.provider)) {
    const sharedSize = model.provider === 'openai-compatible' && has('video');
    fields.push({ key: 'size', label: sharedSize ? '图片与视频尺寸' : '图片尺寸', operation: 'image', type: 'select', customSize: true,
      options: [...(!sharedSize && model.provider === 'openai-compatible' ? ['auto'] : []), '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2560x1440', '1440x2560', ...(sharedSize ? ['1280x720', '720x1280'] : [])],
      hint: sharedSize ? '图片与视频共用尺寸，须确认两种模型均支持。' : '选择常用尺寸，或自定义；支持范围以所选模型为准。' });
    if (model.provider === 'openai-compatible') fields.push({ key: 'quality', label: '图片质量', operation: 'image', type: 'select', options: ['auto', 'low', 'medium', 'high', 'standard', 'hd'] });
  }
  if (has('video') && model.provider === 'openai-compatible') {
    if (!has('image')) fields.push({ key: 'size', label: '视频尺寸', operation: 'video', type: 'text', hint: '填写宽x高；所接兼容视频服务须支持该尺寸。' });
    fields.push({ key: 'seconds', label: '视频时长（秒）', operation: 'video', type: 'number', min: 1, max: 600, integer: true });
  }
  if (has('video') && model.provider === 'seedance') fields.push(
    { key: 'resolution', label: '视频分辨率', operation: 'video', type: 'select', options: ['480p', '720p', '1080p', '4k'] },
    { key: 'duration', label: '视频时长（秒）', operation: 'video', type: 'number', min: 1, max: 600, integer: true },
    { key: 'ratio', label: '视频比例', operation: 'video', type: 'select', options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] },
    { key: 'characterReferenceMode', label: '角色参考方式', operation: 'video', type: 'select', options: ['first_frame', 'reference_image'], hint: 'first_frame 仅支持一张首帧；reference_image 须使用支持多模态参考图的 Seedance 2.x 模型。' });
  if (has('tts') && ['openai-compatible', 'qwen-tts'].includes(model.provider)) {
    fields.push({ key: 'voice', label: '配音音色', operation: 'tts', type: 'text', hint: '填写所接模型支持的音色 ID。' });
    if (model.provider === 'openai-compatible') fields.push({ key: 'speed', label: '配音语速', operation: 'tts', type: 'number', min: .25, max: 4 });
    else fields.push({ key: 'language_type', label: '配音语言', operation: 'tts', type: 'select', options: ['Auto', 'Chinese', 'English', 'German', 'Italian', 'Portuguese', 'Spanish', 'Japanese', 'Korean', 'French', 'Russian'] });
  }
  if (has('tts') && model.provider === 'volcengine-tts') fields.push(
    { key: 'voice', label: '配音音色', operation: 'tts', type: 'text', required: true, hint: '选择当前资源版本的音色，或填写自定义 Speaker ID。' },
    { key: 'audio_params.speech_rate', label: '配音语速', operation: 'tts', type: 'number', min: -50, max: 100, hint: '0 为正常语速，-50 为 0.5 倍，100 为 2 倍。' },
    { key: 'audio_params.sample_rate', label: '采样率', operation: 'tts', type: 'select', options: ['8000', '16000', '22050', '24000', '32000', '44100', '48000'] },
    { key: 'appId', label: 'App ID（旧版控制台）', operation: 'tts', type: 'text', hint: '新版 API Key 鉴权留空；旧版控制台填写 App ID，密钥填写 Access Token。' });
  if (has('asr') && model.provider === 'volcengine-asr') fields.push(
    { key: 'timestampGranularity', label: '识别时间粒度', operation: 'asr', type: 'select', options: ['segment', 'word'] },
    { key: 'appId', label: 'App ID（旧版控制台）', operation: 'asr', type: 'text', hint: '新版 API Key 鉴权留空；旧版控制台填写 App ID，密钥填写 Access Token。' });
  if (has('asr') && model.provider === 'openai-compatible') fields.push(
    { key: 'timestampGranularity', label: '识别时间粒度', operation: 'asr', type: 'select', options: ['segment', 'word'] },
    { key: 'asrResponseFormat', label: '识别返回格式', operation: 'asr', type: 'select', options: ['verbose_json', 'diarized_json'] },
    { key: 'language', label: '识别语言', operation: 'asr', type: 'text', hint: '例如 zh 或 en，留空由模型识别。' });
  return fields;
}

export function modelParameterValue(parameters: Record<string, JsonValue>, key: string): JsonValue | undefined {
  let value: JsonValue | undefined = parameters;
  for (const part of key.split('.')) value = value && typeof value === 'object' && !Array.isArray(value) ? value[part] : undefined;
  return value;
}
export function withModelParameter(parameters: Record<string, JsonValue>, key: string, value: JsonValue | undefined): Record<string, JsonValue> {
  const parts = key.split('.');
  if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('模型参数路径无效。');
  const result = structuredClone(parameters); let target = result;
  for (const part of parts.slice(0, -1)) {
    const existing = target[part];
    target[part] = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    target = target[part] as Record<string, JsonValue>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete target[last]; else target[last] = value;
  return result;
}

/** Validate only supported structured fields; unknown advanced parameters are retained. */
export function validateModelParameters(model: WithParameters): void {
  if (model.provider === 'ollama' && model.capabilities.includes('text')) {
    const options = model.parameters.options;
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new Error('Ollama options 须为 JSON 对象。');
    for (const key of ['temperature', 'max_tokens', 'num_predict']) if (model.parameters[key] !== undefined) throw new Error(`Ollama 的 ${key} 须放入 options，最大输出使用 options.num_predict。`);
  }
  for (const field of getModelParameterFields(model)) {
    const value = modelParameterValue(model.parameters, field.key);
    if (field.required && (value === undefined || typeof value === 'string' && !value.trim())) throw new Error(`请填写${field.label}。`);
    if (value === undefined) continue;
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || field.integer && !Number.isSafeInteger(value) || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max) throw new Error(`${field.label}须为${field.integer ? '整数' : '有限数值'}${field.min !== undefined ? `，不小于 ${field.min}` : ''}${field.max !== undefined ? `，不大于 ${field.max}` : ''}。`);
    } else if (typeof value !== 'string' || !value.trim()) throw new Error(`${field.label}须为非空文字，留空时请移除该参数。`);
    else if (field.options && !field.customSize && !field.options.includes(value)) throw new Error(`${field.label}须为 ${field.options.join(' / ')}。`);
    else if (field.key === 'size' && !(/^\d{2,5}x\d{2,5}$/.test(value) && value.split('x').every(part => Number(part) > 0) || field.operation === 'image' && (model.provider === 'seedream' ? /^(?:1|1\.5|2|3|4)K$/.test(value) : value === 'auto'))) throw new Error(`${field.label}须使用宽x高${field.operation === 'image' ? model.provider === 'seedream' ? '或模型支持的 K 档位' : '或 auto' : ''}。`);
  }
  if (model.provider !== 'ollama' && model.capabilities.includes('text')) {
    const keys = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(key => model.parameters[key] !== undefined);
    for (const key of keys) {
      const value = model.parameters[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (model.textProtocol === 'responses' ? 16 : 1)) throw new Error(`${key} 须为不小于 ${model.textProtocol === 'responses' ? 16 : 1} 的整数。`);
    }
    if (keys.length > 1) throw new Error(`${keys.join(' 与 ')} 不能同时配置。`);
  }
  if (model.provider === 'openai-compatible' && model.capabilities.includes('asr') && model.parameters.asrResponseFormat === 'diarized_json' && model.parameters.timestampGranularity === 'word') throw new Error('diarized_json 不支持逐词时间戳，请改用 segment 或 verbose_json。');
  if (model.provider === 'openai-compatible' && model.capabilities.includes('image') && model.capabilities.includes('video') && model.parameters.size === 'auto') throw new Error('图片与视频共用 size 时须使用宽x高；auto 仅适用于单独的图片连接。');
}

const known = ['temperature', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'size', 'quality', 'seconds', 'duration', 'resolution', 'ratio', 'voice', 'speed', 'language', 'language_type', 'timestampGranularity', 'asrResponseFormat', 'num_predict'];
const configuration = ['workflow', 'inputMapping', 'requestPath', 'requestTemplate', 'resultUrlPath', 'resultBase64Path', 'taskIdPath', 'pollPath', 'statusPath', 'characterReferenceMode', 'pollTimeoutSeconds'];

/** Shared profiles can expose several capabilities without leaking their known controls across API calls. */
export function requestModelParameters(model: WithParameters, operation: ModelParameterOperation): Record<string, JsonValue> {
  validateModelParameters(model);
  if (operation !== 'text' && (model.provider === 'custom-http' || model.provider === 'comfyui')) return structuredClone(model.parameters);
  const allowed = new Set(getModelParameterFields(model).filter(field => field.operation === operation).map(field => field.key.split('.')[0]));
  if (operation === 'text' && model.provider !== 'ollama') for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) allowed.add(key);
  if (operation === 'text' && model.provider === 'ollama') allowed.add('options');
  if (operation === 'video' && model.provider === 'openai-compatible' && model.capabilities.includes('video')) allowed.add('size');
  return Object.fromEntries(Object.entries(model.parameters).filter(([key]) => !configuration.includes(key) && (!known.includes(key) || allowed.has(key)) && (key !== 'options' || operation === 'text' && model.provider === 'ollama')));
}
