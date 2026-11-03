import { isVideoGenerationNode, validateModelParameters, type ModelProfile, type WorkflowNode } from '@video-quickly/contracts';

export class ExecutionModelError extends Error {
  constructor(message: string, readonly target: 'step' | 'models') { super(message); }
}

/** Shared by execution and read-only readiness checks; never resolves credentials or calls a service. */
export function validateExecutionModel(node: WorkflowNode, model: ModelProfile | undefined) {
  if (node.config.operation === 'prepare-edit' && model) throw new ExecutionModelError('剪辑准备使用本地时间轴，请移除此步骤的模型。', 'step');
  if (!model && (node.config.requiresModel === true || isVideoGenerationNode(node) || node.config.operation === 'prepare-references' && node.config.referenceMode === 'generate')) throw new ExecutionModelError(`请为「${node.label}」选择可用的模型。`, 'step');
  if (node.modelId && (!model || !model.enabled)) throw new ExecutionModelError('该步骤选择的模型不可用，请修改配置后创建新的运行。', model ? 'models' : 'step');
  if (!model) return;
  try { validateModelParameters(model); }
  catch (failure) { throw new ExecutionModelError(failure instanceof Error ? failure.message : '模型参数无效。', 'models'); }
  if (['brief', 'research', 'style', 'script', 'agent'].includes(node.kind) && !model.capabilities.includes('text')) throw new ExecutionModelError('此步骤需要具备文本能力的模型。', 'step');
  if (node.kind === 'agent' && !model.capabilities.includes('tools')) throw new ExecutionModelError('Agent 步骤需要具备工具调用能力的模型。', 'step');
  const capability = node.kind === 'assets' ? 'image' : node.kind === 'animation' ? 'video' : undefined;
  if (capability && !model.capabilities.includes(capability)) throw new ExecutionModelError('所选模型不具备此步骤需要的生成能力，请修改配置后创建新的运行。', 'step');
  const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
  if (protocols[node.kind] && !protocols[node.kind].includes(model.provider)) throw new ExecutionModelError('所选模型的服务协议不适用于此步骤，请修改配置后创建新的运行。', 'step');
}
