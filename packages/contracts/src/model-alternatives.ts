import { supportsProductionAgent, validateModelConnection, validateModelParameters, type ModelCapability, type ModelProfile, type WorkflowNode } from './index.js';

export interface ModelFailureContext {
  error?: string; unknownSubmission?: boolean; runStatus?: string; queueOwned?: boolean; trial?: boolean;
}
export type ModelFailureKind = 'unknown-submission' | 'credentials' | 'rate-limit' | 'service' | 'configuration' | 'other';
export function classifyModelFailure(failure: ModelFailureContext): ModelFailureKind {
  if (failure.unknownSubmission) return 'unknown-submission';
  const error = failure.error ?? '';
  if (/\b(401|403)\b|凭据|访问权限|认证/i.test(error)) return 'credentials';
  if (/\b429\b|限流|速率|rate.?limit/i.test(error)) return 'rate-limit';
  if (/\b5\d\d\b|连接|网络|超时|timeout|fetch failed/i.test(error)) return 'service';
  if (/\b(400|404|422)\b|模型.*不可用|不具备|协议|参数|不支持/i.test(error)) return 'configuration';
  return 'other';
}
export function modelPriceDescription(model: Pick<ModelProfile, 'pricing'>, capability: ModelCapability): string {
  const price = model.pricing;
  if (!price) return '价格未配置';
  const currency = price.currency === 'CNY' ? '¥' : '$';
  if (capability === 'image' && price.perImage !== undefined) return `${currency}${price.perImage}/张（配置价格）`;
  if (capability === 'video' && price.perVideoSecond !== undefined) return `${currency}${price.perVideoSecond}/秒（配置价格）`;
  if (capability === 'text') {
    const parts = [price.inputPerMillionTokens !== undefined ? `输入 ${currency}${price.inputPerMillionTokens}` : '', price.outputPerMillionTokens !== undefined ? `输出 ${currency}${price.outputPerMillionTokens}` : ''].filter(Boolean);
    if (parts.length) return `${parts.join(' / ')}／百万 Token（配置价格）`;
  }
  return '此能力价格未配置';
}
export function modelAlternatives(node: WorkflowNode, models: readonly ModelProfile[], failure: ModelFailureContext = {}) {
  const capability: ModelCapability | undefined = node.config.operation === 'prepare-edit' || node.config.operation === 'prepare-references' && node.config.referenceMode !== 'generate'
    ? undefined : ['brief', 'research', 'style', 'script', 'agent'].includes(node.kind) ? 'text' : node.kind === 'assets' ? 'image' : node.kind === 'animation' ? 'video' : undefined;
  const kind = classifyModelFailure(failure);
  const blocked = failure.unknownSubmission || failure.queueOwned || failure.trial || ['queued', 'running', 'waiting_review', 'waiting_external', 'retry_scheduled'].includes(failure.runStatus ?? '');
  const guidance = failure.unknownSubmission ? '原任务提交结果尚未确认，请先核对服务端任务；切换配置不会恢复或取消原任务。'
    : failure.queueOwned ? '该任务属于生产队列，请先在队列中处理当前项，再保存模型配置并重新建项。'
    : failure.trial ? '请在提示词实验中更换模型、重新预览并显式试运行。'
    : blocked ? '请先完成或停止当前任务，再按新配置创建运行。'
    : kind === 'credentials' ? '先检查访问权限与凭据；同一服务地址的其他模型可能受相同权限限制。'
    : kind === 'rate-limit' ? '可等待限流恢复，或为下次运行选择其他服务。'
    : kind === 'configuration' ? '请检查原模型的参数和协议；替代配置仍需在开始制作前通过校验。'
    : '选择只修改下一次运行的模型配置，原运行与提交凭据会保留。';
  const selected = models.find(model => model.id === node.modelId);
  const serviceAddress = (value: string) => { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; };
  const alternatives = !capability ? [] : models.filter(model => {
    if (!model.enabled || model.id === node.modelId || !model.capabilities.includes(capability)) return false;
    if (node.kind === 'agent' && !supportsProductionAgent(model)) return false;
    if (capability === 'text' && !['openai-compatible', 'ollama'].includes(model.provider)) return false;
    if (capability === 'image' && !['openai-compatible', 'seedream', 'comfyui', 'custom-http'].includes(model.provider)) return false;
    if (capability === 'video' && !['openai-compatible', 'seedance', 'comfyui', 'custom-http'].includes(model.provider)) return false;
    try { validateModelConnection(model); validateModelParameters(model); } catch { return false; }
    return true;
  }).map(model => {
    const sameService = selected ? serviceAddress(model.baseUrl) === serviceAddress(selected.baseUrl) : false;
    const reasons = [model.provider === selected?.provider ? '沿用当前协议' : '使用不同服务协议', ...(sameService && ['credentials', 'rate-limit', 'service'].includes(kind) ? ['与原模型共用服务地址'] : [])];
    return { model, reasons, price: modelPriceDescription(model, capability), sameService };
  }).sort((a, b) => {
    const serviceProblem = ['credentials', 'rate-limit', 'service'].includes(kind);
    return (serviceProblem ? Number(a.sameService) - Number(b.sameService) : 0) || Number(b.model.provider === selected?.provider) - Number(a.model.provider === selected?.provider) || a.model.name.localeCompare(b.model.name) || a.model.id.localeCompare(b.model.id);
  });
  return { capability, kind, guidance, canCreateRun: !blocked, alternatives };
}
