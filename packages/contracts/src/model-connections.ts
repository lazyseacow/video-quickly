import type { ModelCapability, ModelConnectionType, ModelPlatform, ModelProfile } from './index.js';
import { getMediaAdapters } from './model-protocols.js';

export const modelConnectionTypes: readonly { id: ModelConnectionType; label: string; description: string; capabilities: readonly ModelCapability[]; platforms: readonly ModelPlatform[] }[] = [
  { id: 'text', label: '文本模型', description: '文本创作与问答', capabilities: ['text', 'vision', 'tools', 'structured-output'], platforms: ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'volcengine', 'moonshot', 'zhipu', 'siliconflow', 'openrouter', 'ollama', 'custom'] },
  { id: 'image', label: '图片模型', description: '图片生成与编辑', capabilities: ['image'], platforms: ['openai', 'seedream', 'comfyui', 'custom'] },
  { id: 'video', label: '视频模型', description: '文字或参考图片生成视频', capabilities: ['video'], platforms: ['seedance', 'comfyui', 'custom'] },
];

export function getModelConnectionType(model: Pick<ModelProfile, 'connectionType'>): ModelConnectionType {
  return model.connectionType;
}

type ToolConnection = Pick<ModelProfile, 'provider' | 'platform' | 'baseUrl' | 'model' | 'textProtocol' | 'parameters'>;

function isOfficialOpenAI(model: Pick<ModelProfile, 'platform' | 'baseUrl'>): boolean {
  return model.platform === 'openai' || URL.canParse(model.baseUrl) && new URL(model.baseUrl).hostname === 'api.openai.com';
}

export function modelToolProtocolIssue(model: ToolConnection): string | undefined {
  if (model.provider !== 'openai-compatible') return '此 API 协议尚未接入 Agent 工具调用。';
  if (!isOfficialOpenAI(model) || model.textProtocol === 'responses' || model.textProtocol === 'messages') return;
  if (/^gpt-6(?:-astra|\.1-(?:sol|terra))(?:-|$)/.test(model.model)) return '此 OpenAI 模型的工具调用需要 Responses API。';
  if (/^gpt-6-(?:sol|luna)(?:-|$)/.test(model.model) && model.parameters.reasoning_effort !== 'none') {
    return '此 OpenAI 模型通过 Chat Completions 调用工具时，reasoning_effort 须为 none，也可使用 Responses API。';
  }
  return undefined;
}

export function validateModelConnection(model: ToolConnection & Pick<ModelProfile, 'connectionType' | 'capabilities' | 'authMode' | 'fullUrl'>): void {
  if (!model.connectionType) throw new Error('请选择文本、图片或视频模型类型。');
  const definition = modelConnectionTypes.find(type => type.id === model.connectionType)!;
  if (model.connectionType === 'video' && isOfficialOpenAI(model)) throw new Error('OpenAI 官方视频接口已停止服务，请选择其他视频平台或填写兼容网关地址。');
  if (model.platform && !definition.platforms.includes(model.platform)) throw new Error(`所选平台不支持${definition.label}连接。`);
  if (model.capabilities.some(capability => !definition.capabilities.includes(capability))) throw new Error(`${definition.label}包含不属于该类型的能力，请分别添加连接。`);
  const required = model.connectionType;
  if (required && !model.capabilities.includes(required)) throw new Error(`${definition.label}缺少必要的模型能力。`);
  if (model.connectionType === 'text') {
    if (!['openai-compatible', 'ollama'].includes(model.provider)) throw new Error('文本模型请选择对话 API 或 Ollama 原生接口。');
    const issue = model.capabilities.includes('tools') && modelToolProtocolIssue(model);
    if (issue) throw new Error(issue);
  } else {
    if (model.fullUrl || model.authMode && model.authMode !== 'protocol-default') throw new Error('完整请求地址和自定义鉴权方式用于文本连接。');
    if (!getMediaAdapters(model.capabilities).some(adapter => adapter.id === model.provider)) throw new Error(`${definition.label}的 API 协议不支持所选能力。`);
  }
}
