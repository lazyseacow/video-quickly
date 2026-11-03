import type { ModelCapability, ModelConnectionType, ModelPlatform, ModelProfile } from './index.js';
import { getMediaAdapters } from './model-protocols.js';

export const modelConnectionTypes: readonly { id: ModelConnectionType; label: string; description: string; capabilities: readonly ModelCapability[]; platforms: readonly ModelPlatform[] }[] = [
  { id: 'text', label: '文本模型', description: '文本创作与问答', capabilities: ['text', 'vision', 'tools', 'structured-output'], platforms: ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'volcengine', 'moonshot', 'zhipu', 'siliconflow', 'openrouter', 'ollama', 'custom'] },
  { id: 'image', label: '图片模型', description: '图片生成与编辑', capabilities: ['image'], platforms: ['openai', 'seedream', 'comfyui', 'custom'] },
  { id: 'video', label: '视频模型', description: '文字或参考图片生成视频', capabilities: ['video'], platforms: ['openai', 'seedance', 'comfyui', 'custom'] },
];

export function getModelConnectionType(model: Pick<ModelProfile, 'connectionType'>): ModelConnectionType {
  return model.connectionType;
}

export function getModelCapabilities(model: Pick<ModelProfile, 'provider' | 'capabilities'>): ModelCapability[] {
  return model.capabilities.includes('text') && ['openai-compatible', 'ollama'].includes(model.provider)
    ? [...new Set<ModelCapability>([...model.capabilities, 'vision', 'tools', 'structured-output'])]
    : [...model.capabilities];
}

export function validateModelConnection(model: Pick<ModelProfile, 'connectionType' | 'provider' | 'capabilities'>): void {
  if (!model.connectionType) throw new Error('请选择文本、图片或视频模型类型。');
  const definition = modelConnectionTypes.find(type => type.id === model.connectionType)!;
  if (model.capabilities.some(capability => !definition.capabilities.includes(capability))) throw new Error(`${definition.label}包含不属于该类型的能力，请分别添加连接。`);
  const required = model.connectionType;
  if (required && !model.capabilities.includes(required)) throw new Error(`${definition.label}缺少必要的模型能力。`);
  if (model.connectionType === 'text') {
    if (!['openai-compatible', 'ollama'].includes(model.provider)) throw new Error('文本模型请选择对话 API 或 Ollama 原生接口。');
  } else if (!getMediaAdapters(model.capabilities).some(adapter => adapter.id === model.provider)) throw new Error(`${definition.label}的 API 协议不支持所选能力。`);
}
