import type { ModelCapability, ModelProfile, TextProtocol } from './index.js';

export const textProtocols: readonly { id: TextProtocol; label: string; path: string }[] = [
  { id: 'chat-completions', label: 'Chat Completions', path: 'chat/completions' },
  { id: 'responses', label: 'Responses API', path: 'responses' },
  { id: 'messages', label: 'Anthropic Messages', path: 'messages' },
];

export const mediaAdapters: readonly { id: ModelProfile['provider']; label: string; capabilities: readonly ModelCapability[] }[] = [
  { id: 'openai-compatible', label: 'OpenAI 兼容接口', capabilities: ['image', 'video', 'tts', 'asr'] },
  { id: 'seedream', label: 'Seedream 图片接口', capabilities: ['image'] },
  { id: 'seedance', label: 'Seedance 视频接口', capabilities: ['video'] },
  { id: 'qwen-tts', label: 'Qwen TTS 配音接口', capabilities: ['tts'] },
  { id: 'volcengine-tts', label: '豆包语音合成 V3', capabilities: ['tts'] },
  { id: 'volcengine-asr', label: '豆包语音识别（极速版）', capabilities: ['asr'] },
  { id: 'comfyui', label: 'ComfyUI 工作流', capabilities: ['image', 'video'] },
  { id: 'custom-http', label: '自定义 HTTP', capabilities: ['image', 'video', 'tts'] },
];

export function getMediaAdapters(capabilities: readonly ModelCapability[]) {
  const media = capabilities.filter(value => ['image', 'video', 'tts', 'asr'].includes(value));
  return mediaAdapters.filter(adapter => media.length > 0 && media.every(value => adapter.capabilities.includes(value)));
}
