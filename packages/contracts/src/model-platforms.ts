import type { ModelCapability, ModelConnectionType, ModelPlatform, ModelProfile } from './index.js';

export interface ModelPlatformPreset {
  id: ModelPlatform;
  label: string;
  provider: ModelProfile['provider'];
  baseUrl: string;
  capabilities: ModelCapability[];
  textProtocol?: ModelProfile['textProtocol'];
  addressHint?: string;
  addressPlaceholder?: string;
}

export const modelPlatforms: readonly ModelPlatformPreset[] = [
  { id: 'openai', label: 'OpenAI', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', capabilities: ['text'] },
  { id: 'anthropic', label: 'Claude', provider: 'openai-compatible', textProtocol: 'messages', baseUrl: 'https://api.anthropic.com/v1', capabilities: ['text'] },
  { id: 'google', label: 'Gemini', provider: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', capabilities: ['text'] },
  { id: 'deepseek', label: 'DeepSeek', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com', capabilities: ['text'] },
  { id: 'qwen', label: '通义千问 / 百炼', provider: 'openai-compatible', baseUrl: '', capabilities: ['text'], addressPlaceholder: 'https://工作空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', addressHint: '从百炼控制台复制所在地域的服务地址，包含工作空间 ID。' },
  { id: 'volcengine', label: '豆包 / 火山方舟', provider: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', capabilities: ['text'] },
  { id: 'moonshot', label: 'Kimi / Moonshot', provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', capabilities: ['text'] },
  { id: 'zhipu', label: '智谱 GLM', provider: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', capabilities: ['text'] },
  { id: 'siliconflow', label: '硅基流动', provider: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', capabilities: ['text'] },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', capabilities: ['text'] },
  { id: 'ollama', label: 'Ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', capabilities: ['text'] },
  { id: 'comfyui', label: 'ComfyUI', provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', capabilities: ['image'] },
  { id: 'seedream', label: '即梦 Seedream', provider: 'seedream', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', capabilities: ['image'] },
  { id: 'seedance', label: '即梦 Seedance', provider: 'seedance', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', capabilities: ['video'] },
  { id: 'qwen-tts', label: 'Qwen TTS', provider: 'qwen-tts', baseUrl: '', capabilities: ['tts'], addressPlaceholder: 'https://工作空间ID.cn-beijing.maas.aliyuncs.com/api/v1', addressHint: '从百炼控制台复制所在地域的原生 API 服务地址，包含工作空间 ID。' },
  { id: 'custom', label: '自定义服务', provider: 'openai-compatible', baseUrl: '', capabilities: ['text'] },
];

export function platformForConnection(platform: ModelPlatform, type?: ModelConnectionType): ModelPlatformPreset {
  const preset = modelPlatforms.find(item => item.id === platform)!;
  return platform === 'volcengine' && type === 'audio' ? { ...preset, label: '豆包语音 / 火山引擎', provider: 'volcengine-tts', baseUrl: 'https://openspeech.bytedance.com/api/v3', capabilities: ['tts'], addressHint: '使用豆包语音控制台的 API Key；旧版控制台可在参数中填写 App ID，并将 Access Token 填入密钥。' } : preset;
}

export function getModelPlatform(model: Pick<ModelProfile, 'platform' | 'provider' | 'baseUrl'>): ModelPlatformPreset {
  if (model.provider === 'volcengine-tts' || model.provider === 'volcengine-asr') return platformForConnection('volcengine', 'audio');
  const explicit = model.platform && modelPlatforms.find(item => item.id === model.platform);
  if (explicit) return explicit;
  if (model.provider !== 'openai-compatible') return modelPlatforms.find(item => item.provider === model.provider) ?? modelPlatforms.at(-1)!;
  const host = new URL(model.baseUrl).hostname;
  const inferred = modelPlatforms.find(item => item.baseUrl && item.provider === 'openai-compatible' && new URL(item.baseUrl).hostname === host);
  if (inferred) return inferred;
  if (host.endsWith('.maas.aliyuncs.com') || host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com') return modelPlatforms.find(item => item.id === 'qwen')!;
  return modelPlatforms.at(-1)!;
}
