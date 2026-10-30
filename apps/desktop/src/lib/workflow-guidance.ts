import { getMediaAdapters, type ModelCapability, type ModelProfile, type WorkflowNode } from '@video-quickly/contracts';

interface StepGuidance {
  purpose: string; result: string; review: string; local: string; capability?: ModelCapability; requiresModel?: boolean;
}
const guidance: Record<WorkflowNode['kind'], StepGuidance> = {
  brief: { purpose: '明确视频主题、观众和想讲清楚的问题。', result: '创作主题与内容方向', review: '主题和目标观众是否明确。', local: '项目简报', capability: 'text' },
  research: { purpose: '整理资料和事实依据，为文案提供参考。', result: '资料摘要与待核验主张', review: '来源是否可靠，待核验内容是否已标明。', local: '已有资料', capability: 'text' },
  style: { purpose: '统一画风、色调与角色设定。', result: '视觉风格与角色要求', review: '画风、色调和角色设定是否一致。', local: '项目风格', capability: 'text' },
  script: { purpose: '把主题拆成镜头，编写旁白、画面要求和时长。', result: '旁白、画面要求和镜头时长', review: '叙事顺序、旁白内容和每个镜头的时长是否合适。', local: '已有分镜', capability: 'text' },
  assets: { purpose: '为每个镜头准备图片与画面素材。', result: '与镜头对应的画面素材', review: '画面是否对应镜头，角色与风格是否一致。', local: '已有画面', capability: 'image' },
  voice: { purpose: '根据旁白生成配音，为字幕对齐准备音频。', result: '各镜头的旁白音频', review: '试听发音、语速、停顿和旁白内容。', local: '已有录音', capability: 'tts' },
  animation: { purpose: '生成镜头视频，或沿用已有画面的动画与运镜。', result: '镜头视频或动画设置', review: '预览动作、镜头运动、衔接和时长。', local: '已有运镜', capability: 'video' },
  review: { purpose: '检查小样，确认画面、声音和字幕是否衔接。', result: '小样审阅结果', review: '检查完整叙事、画面、声音、字幕与资料引用。', local: '人工审阅' },
  export: { purpose: '按视频规格组合画面、声音和字幕，导出成片。', result: '可播放的 MP4 文件', review: '检查成片内容、视频规格和输出位置。', local: '本地导出' },
  agent: { purpose: '由 AI 结合绑定的工具完成自定义创作任务。', result: '本步骤要求的创作结果', review: '任务结果是否符合要求，工具输出是否需要核验。', local: '请选择模型', capability: 'text', requiresModel: true },
  condition: { purpose: '按条件选择接下来执行的路线。', result: '条件判断结果', review: '确认条件和分支连接符合预期。', local: '条件判断' },
  join: { purpose: '汇合上游分支，再继续后续制作。', result: '已汇合的上游结果', review: '确认需要的上游步骤均已接入。', local: '分支汇合' },
  subflow: { purpose: '执行已经保存的子流程，复用一组制作步骤。', result: '子流程声明的输出', review: '检查输入绑定和子流程结果。', local: '子流程配置' },
};

export function stepGuidance(node: Pick<WorkflowNode, 'kind' | 'config'>): StepGuidance {
  if (node.config.operation === 'transcribe') return { purpose: '识别已有音频并生成字幕。', result: '带时间信息的字幕', review: '核对识别文字与字幕时间。', local: '请选择识别模型', capability: 'asr', requiresModel: true };
  return guidance[node.kind];
}

export function matchingStepModels(node: Pick<WorkflowNode, 'kind' | 'config'>, models: readonly ModelProfile[]): ModelProfile[] {
  const { capability } = stepGuidance(node);
  if (!capability) return [];
  const adapters = ['image', 'video', 'tts', 'asr'].includes(capability) ? getMediaAdapters([capability]) : undefined;
  return models.filter(model => model.enabled && model.capabilities.includes(capability)
    && (node.kind !== 'agent' || model.capabilities.includes('tools'))
    && (!adapters || adapters.some(adapter => adapter.id === model.provider)));
}

export function stepModelLabel(node: Pick<WorkflowNode, 'kind' | 'config' | 'modelId'>, models: readonly ModelProfile[]): string {
  if (!node.modelId) return stepGuidance(node).local;
  const model = models.find(item => item.id === node.modelId);
  if (!model) return '模型已移除';
  if (!model.enabled) return '模型已停用';
  return matchingStepModels(node, [model]).length ? model.name : '模型能力不匹配';
}
