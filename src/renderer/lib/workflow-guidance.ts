import { getMediaAdapters, supportsProductionAgent, type ModelCapability, type ModelProfile, type WorkflowNode } from '@video-quickly/contracts';

interface StepGuidance {
  purpose: string; result: string; review: string; local: string; capability?: ModelCapability; requiresModel?: boolean;
}
const guidance: Record<WorkflowNode['kind'], StepGuidance> = {
  brief: { purpose: '明确视频主题、观众和想讲清楚的问题。', result: '创作主题与内容方向', review: '主题和目标观众是否明确。', local: '项目简报', capability: 'text' },
  research: { purpose: '整理资料和事实依据，为文案提供参考。', result: '资料摘要与待核验主张', review: '来源是否可靠，待核验内容是否已标明。', local: '已有资料', capability: 'text' },
  style: { purpose: '统一画风、色调与角色设定。', result: '视觉风格与角色要求', review: '画风、色调和角色设定是否一致。', local: '项目风格', capability: 'text' },
  script: { purpose: '把主题拆成镜头，编写旁白、画面要求和时长。', result: '旁白、画面要求和镜头时长', review: '叙事顺序、旁白内容和每个镜头的时长是否合适。', local: '已有分镜', capability: 'text' },
  assets: { purpose: '为每个镜头准备图片与画面素材。', result: '与镜头对应的画面素材', review: '画面是否对应镜头，角色与风格是否一致。', local: '已有画面', capability: 'image' },
  animation: { purpose: '生成镜头视频，或沿用已有画面的动画与运镜。', result: '镜头视频或动画设置', review: '预览动作、镜头运动、衔接和时长。', local: '已有运镜', capability: 'video' },
  review: { purpose: '自动检查画面、声音和字幕的完整性。', result: '自动检查结果', review: '检查完整叙事、画面、声音与字幕。', local: '自动检查' },
  export: { purpose: '按视频规格组合画面、声音和字幕，导出成片。', result: '可播放的 MP4 文件', review: '检查成片内容、视频规格和输出位置。', local: '本地导出' },
  agent: { purpose: '由 AI 结合绑定的工具完成自定义创作任务。', result: '本步骤要求的创作结果', review: '任务结果是否符合要求，工具输出是否需要核验。', local: '请选择模型', capability: 'text', requiresModel: true },
  condition: { purpose: '按条件选择接下来执行的路线。', result: '条件判断结果', review: '确认条件和分支连接符合预期。', local: '条件判断' },
  join: { purpose: '汇合上游分支，再继续后续制作。', result: '已汇合的上游结果', review: '确认需要的上游步骤均已接入。', local: '分支汇合' },
  subflow: { purpose: '执行已经保存的子流程，复用一组制作步骤。', result: '子流程声明的输出', review: '检查输入绑定和子流程结果。', local: '子流程配置' },
};

export function stepGuidance(node: Pick<WorkflowNode, 'kind' | 'config'>): StepGuidance {
  if (node.config.operation === 'prepare-references') return { ...guidance.assets, purpose: node.config.useFirstShotReference === true ? '先生成第一镜首帧，再以它和角色参考图生成后续首帧。' : '准备参考素材，或直接使用文字生成视频。', local: '参考素材准备', capability: node.config.referenceMode === 'generate' ? 'image' : undefined, requiresModel: node.config.referenceMode === 'generate' };
  if (node.config.operation === 'prepare-edit') return { ...guidance.animation, capability: undefined, local: '本地剪辑准备' };
  return node.config.requiresModel === true ? { ...guidance[node.kind], requiresModel: true } : guidance[node.kind];
}

export function matchingStepModels(node: Pick<WorkflowNode, 'kind' | 'config'>, models: readonly ModelProfile[]): ModelProfile[] {
  const { capability } = stepGuidance(node);
  if (!capability) return [];
  const adapters = ['image', 'video'].includes(capability) ? getMediaAdapters([capability]) : undefined;
  return models.filter(model => model.enabled && model.capabilities.includes(capability)
    && (node.kind !== 'agent' || supportsProductionAgent(model))
    && (!adapters || adapters.some(adapter => adapter.id === model.provider)));
}

export function stepModelLabel(node: Pick<WorkflowNode, 'kind' | 'config' | 'modelId'>, models: readonly ModelProfile[]): string {
  if (!node.modelId) return stepGuidance(node).local;
  const model = models.find(item => item.id === node.modelId);
  if (!model) return '模型已移除';
  if (!model.enabled) return '模型已停用';
  return matchingStepModels(node, [model]).length ? model.name : '模型能力不匹配';
}

export function stepModelPlaceholder(node: Pick<WorkflowNode, 'kind' | 'config'>, models: readonly ModelProfile[]): string {
  if (!models.length) return '无可用模型';
  const help = stepGuidance(node);
  return help.requiresModel ? '请选择模型' : `${help.local}（不调用模型）`;
}
