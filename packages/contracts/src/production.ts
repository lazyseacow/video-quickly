import { z } from 'zod';
import type { ModelProfile, WorkflowDefinition, WorkflowNode } from './index.js';
import { manualPlanningFieldsSchema } from './planning-fields.js';
import { modelToolProtocolIssue } from './model-connections.js';

export const MAX_REFERENCE_AUDIO_BYTES = 15_000_000;
export const MAX_REFERENCE_AUDIOS = 10;
export const productionPlanningSteps = ['brief', 'style', 'script'] as const;
export type ProductionPlanningStep = typeof productionPlanningSteps[number];
const textModelTasks = new Set<WorkflowNode['kind']>(['brief', 'style', 'script', 'research', 'agent']);

export const productionSettingsSchema = z.object({
  mode: z.literal('native-video'),
  agentSkillIds: z.array(z.string().min(1)).default([]),
  agentInheritsPlanningSkills: z.boolean().optional(),
  agentMcpServerIds: z.array(z.string().min(1)).default([]),
  manualPlanningSteps: z.array(z.enum(productionPlanningSteps)).max(3).refine(steps => new Set(steps).size === steps.length, '策划步骤不能重复。').optional(),
  manualPlanningFields: manualPlanningFieldsSchema.optional(),
  textModelId: z.string().min(1).optional(), videoModelId: z.string().min(1).optional(), imageModelId: z.string().min(1).optional(),
  referenceMode: z.enum(['none', 'existing', 'generate']).default('none'),
  referenceAudioAssetIds: z.array(z.string().min(1)).max(MAX_REFERENCE_AUDIOS).refine(ids => new Set(ids).size === ids.length, '参考音频不能重复。').optional(),
  soundPrompt: z.string().max(10000).default('使用自然清晰的中文人声，保持全片声音风格一致，环境音与画面匹配。'),
  subtitleMode: z.enum(['off', 'script']).default('off'),
});
export type ProductionSettings = z.infer<typeof productionSettingsSchema>;

export function productionPlanningStep(workflow: Pick<WorkflowDefinition, 'id'>, node: Pick<WorkflowNode, 'id' | 'kind' | 'config'>): ProductionPlanningStep | undefined {
  if (workflow.id !== 'native-video' || node.id !== node.kind || node.config.modelBinding !== 'default') return undefined;
  if (node.kind === 'brief' || node.kind === 'style' || node.kind === 'script') return node.kind;
  return undefined;
}

export function usesManualPlanning(workflow: Pick<WorkflowDefinition, 'id' | 'production'>, node: Pick<WorkflowNode, 'id' | 'kind' | 'config'>): boolean {
  const step = productionPlanningStep(workflow, node);
  return Boolean(step && workflow.production.manualPlanningSteps?.includes(step));
}

export function supportsProductionAgent(model: ModelProfile | undefined): boolean {
  return Boolean(model?.enabled && model.capabilities.includes('text') && model.capabilities.includes('tools') && !modelToolProtocolIssue(model));
}

export function productionEditingStep(workflow: WorkflowDefinition): WorkflowNode | undefined {
  return workflow.id === 'native-video' ? workflow.nodes.find(node => node.id === 'animation' && node.kind === 'animation' && node.config.operation === 'prepare-edit') : undefined;
}

export function productionEditingSkillIds(workflow: WorkflowDefinition): string[] {
  const { agentSkillIds, agentInheritsPlanningSkills } = workflow.production;
  if (agentSkillIds.length || agentInheritsPlanningSkills === false || !productionEditingStep(workflow)) return agentSkillIds;

  // Older projects stored the creation selection separately on each of these tasks.
  const [brief, style, script] = ['brief', 'style', 'script'].map(kind =>
    new Set(workflow.nodes.find(node => node.id === kind && node.kind === kind)?.skillIds));
  const selection = [...brief];
  return selection.length && [style, script].every(ids => ids.size === brief.size && selection.every(id => ids.has(id)))
    ? selection : agentSkillIds;
}

export function productionModelSetting(node: Pick<WorkflowNode, 'kind' | 'config'>): 'textModelId' | 'videoModelId' | 'imageModelId' | undefined {
  if (node.config.modelBinding !== 'default' || node.config.modelOverride === true) return undefined;
  if (textModelTasks.has(node.kind)) return 'textModelId';
  if (node.config.operation === 'generate-native-video') return 'videoModelId';
  if (node.config.operation === 'prepare-references') return 'imageModelId';
  return undefined;
}

/** Resolve defaults before recording a run; the recorded nodes remain self-contained. */
export function resolveProductionWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  const settings = workflow.production;
  return { ...workflow, nodes: workflow.nodes.map(node => {
    const setting = productionModelSetting(node);
    let modelId = node.modelId;
    if (node.config.operation === 'prepare-edit' || node.config.operation === 'prepare-references' && settings.referenceMode !== 'generate') modelId = undefined;
    else if (setting) modelId = settings[setting];
    return { ...node, modelId, config: { ...node.config,
      ...(node.config.modelBinding === 'default' && textModelTasks.has(node.kind) || node.config.operation === 'generate-native-video' ? { requiresModel: true } : {}),
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
