import type { ModelCapability, ModelProfile, TextProtocol } from './index.js';

export const textProtocols: readonly { id: TextProtocol; label: string; path: string }[] = [
  { id: 'chat-completions', label: 'Chat Completions', path: 'chat/completions' },
  { id: 'responses', label: 'Responses API', path: 'responses' },
  { id: 'messages', label: 'Anthropic Messages', path: 'messages' },
];

type TextModelProtocol = Pick<ModelProfile, 'provider' | 'textProtocol'>;

export function textModelRoute(model: TextModelProtocol): string {
  return model.provider === 'ollama' ? 'api/chat' : textProtocols.find(item => item.id === (model.textProtocol ?? 'chat-completions'))!.path;
}

export function textModelBasePath(pathname: string, model: TextModelProtocol): string | undefined {
  const route = `/${textModelRoute(model)}`;
  const path = pathname.replace(/\/+$/, '');
  return path.endsWith(route) ? path.slice(0, -route.length) : undefined;
}

export const mediaAdapters: readonly { id: ModelProfile['provider']; label: string; capabilities: readonly ModelCapability[] }[] = [
  { id: 'openai-compatible', label: 'OpenAI 兼容接口', capabilities: ['image', 'video'] },
  { id: 'seedream', label: 'Seedream 图片接口', capabilities: ['image'] },
  { id: 'seedance', label: 'Seedance 视频接口', capabilities: ['video'] },
  { id: 'comfyui', label: 'ComfyUI 工作流', capabilities: ['video'] },
  { id: 'custom-http', label: '自定义 HTTP', capabilities: ['image', 'video'] },
];

export function getMediaAdapters(capabilities: readonly ModelCapability[]) {
  const media = capabilities.filter(value => ['image', 'video'].includes(value));
  return mediaAdapters.filter(adapter => media.length > 0 && media.every(value => adapter.capabilities.includes(value)));
}
