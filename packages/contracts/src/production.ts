import { z } from 'zod';
import type { ModelProfile, WorkflowDefinition, WorkflowNode } from './index.js';

export const MAX_REFERENCE_AUDIO_BYTES = 15_000_000;
export const MAX_REFERENCE_AUDIOS = 10;

export const productionSettingsSchema = z.object({
  mode: z.literal('native-video'),
  agentSkillIds: z.array(z.string().min(1)).default([]),
  agentMcpServerIds: z.array(z.string().min(1)).default([]),
  textModelId: z.string().min(1).optional(), videoModelId: z.string().min(1).optional(), imageModelId: z.string().min(1).optional(),
  referenceMode: z.enum(['none', 'existing', 'generate']).default('none'),
  referenceAudioAssetIds: z.array(z.string().min(1)).max(MAX_REFERENCE_AUDIOS).refine(ids => new Set(ids).size === ids.length, '参考音频不能重复。').optional(),
  soundPrompt: z.string().max(10000).default('使用自然清晰的中文人声，保持全片声音风格一致，环境音与画面匹配。'),
  subtitleMode: z.enum(['off', 'script']).default('off'),
});
export type ProductionSettings = z.infer<typeof productionSettingsSchema>;

export function supportsProductionAgent(model: Pick<ModelProfile, 'enabled' | 'capabilities' | 'provider'> | undefined): boolean {
  return Boolean(model?.enabled && model.provider === 'openai-compatible' && model.capabilities.includes('text') && model.capabilities.includes('tools'));
}

export function productionEditingStep(workflow: WorkflowDefinition): WorkflowNode | undefined {
  return workflow.id === 'native-video' ? workflow.nodes.find(node => node.id === 'animation' && node.kind === 'animation' && node.config.operation === 'prepare-edit') : undefined;
}

/** Resolve defaults before recording a run; the recorded nodes remain self-contained. */
export function resolveProductionWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  const settings = workflow.production;
  return { ...workflow, nodes: workflow.nodes.map(node => {
    let modelId = node.modelId;
    if (node.config.operation === 'prepare-edit' || node.config.operation === 'prepare-references' && settings.referenceMode !== 'generate') modelId = undefined;
    else if (node.config.modelBinding === 'default' && node.config.modelOverride !== true) {
      if (['brief', 'style', 'script', 'research', 'agent'].includes(node.kind)) modelId = settings.textModelId;
      else if (node.config.operation === 'generate-native-video') modelId = settings.videoModelId;
      else if (node.config.operation === 'prepare-references') modelId = settings.referenceMode === 'generate' ? settings.imageModelId : undefined;
    }
    return { ...node, modelId, config: { ...node.config,
      ...(node.config.modelBinding === 'default' && ['brief', 'style', 'script', 'research', 'agent'].includes(node.kind) || node.config.operation === 'generate-native-video' ? { requiresModel: true } : {}),
      ...(node.config.operation === 'prepare-references' ? { referenceMode: settings.referenceMode } : {}),
      ...(node.config.operation === 'generate-native-video' ? { soundPrompt: settings.soundPrompt } : {}),
    } };
  }) };
}

export function isVideoGenerationNode(node: Pick<WorkflowNode, 'kind' | 'config'>): boolean {
  return node.kind === 'animation' && node.config.operation !== 'prepare-edit';
}

export function isModelGenerationNode(node: Pick<WorkflowNode, 'kind' | 'config' | 'modelId'>): boolean {
  if (node.config.operation === 'prepare-edit' || node.config.operation === 'prepare-references' && node.config.referenceMode !== 'generate') return false;
  return ['brief', 'style', 'script', 'research', 'agent', 'assets', 'animation'].includes(node.kind)
    && Boolean(node.modelId || node.config.requiresModel === true || node.config.operation === 'generate-native-video' || node.config.operation === 'prepare-references');
}

export function captionsEnabled(project: { workflow?: Pick<WorkflowDefinition, 'production'> }): boolean {
  return project.workflow?.production?.subtitleMode === 'script';
}
