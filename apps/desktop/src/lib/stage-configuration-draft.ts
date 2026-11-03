import { z } from 'zod';
import { productionSettingsSchema, projectSchema, resolveProductionWorkflow, workflowNodeSchema, type ProductionSettings, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';
import { sameContent } from './project-edits';

export const productionProjectSettingsSchema = projectSchema.pick({ brief: true, style: true, profile: true });
export type ProductionProjectSettings = z.infer<typeof productionProjectSettingsSchema>;
export const stageConfigurationDraftSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  changes: z.array(z.object({ baseline: workflowNodeSchema, node: workflowNodeSchema })).max(100),
  production: z.object({ baseline: productionSettingsSchema, value: productionSettingsSchema }).optional(),
  project: z.object({ baseline: productionProjectSettingsSchema, value: productionProjectSettingsSchema }).optional(),
}).superRefine((draft, context) => {
  const ids = new Set<string>();
  draft.changes.forEach((change, index) => {
    if (change.baseline.id !== change.node.id) context.addIssue({ code: 'custom', path: ['changes', index, 'node', 'id'], message: '阶段配置不能变更任务标识。' });
    if (ids.has(change.node.id)) context.addIssue({ code: 'custom', path: ['changes', index, 'node', 'id'], message: '阶段配置包含重复任务。' });
    ids.add(change.node.id);
  });
});

export type StageConfigurationDraft = z.infer<typeof stageConfigurationDraftSchema>;

export function updateStageConfigurationDraft(projectId: string, previous: StageConfigurationDraft | undefined, currentNodes: WorkflowNode[], nodes: WorkflowNode[]): StageConfigurationDraft {
  const current = new Map(currentNodes.map(node => [node.id, node]));
  if (current.size !== currentNodes.length || new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('阶段配置包含重复任务。');
  const changes = new Map((previous?.projectId === projectId ? previous.changes : []).map(change => [change.node.id, change]));
  for (const node of nodes) {
    const baseline = changes.get(node.id)?.baseline ?? current.get(node.id);
    if (!baseline) throw new Error(`任务「${node.label}」已移除，请重新打开阶段设置。`);
    if (sameContent(node, baseline)) changes.delete(node.id);
    else changes.set(node.id, { baseline, node });
  }
  return stageConfigurationDraftSchema.parse({ ...(previous?.projectId === projectId ? previous : {}), version: 1, projectId, changes: [...changes.values()] });
}

export function updateProductionConfigurationDraft(projectId: string, previous: StageConfigurationDraft | undefined, workflow: WorkflowDefinition, nodes: WorkflowNode[], production: ProductionSettings, current: ProductionProjectSettings, next: ProductionProjectSettings): StageConfigurationDraft {
  if (!workflow.production) throw new Error('当前流程不支持统一制作设置。');
  const draft = updateStageConfigurationDraft(projectId, previous, workflow.nodes, nodes);
  const baseline = draft.production?.baseline ?? workflow.production;
  const projectBaseline = draft.project?.baseline ?? current;
  return stageConfigurationDraftSchema.parse({ ...draft,
    production: sameContent(baseline, production) ? undefined : { baseline, value: production },
    project: sameContent(projectBaseline, next) ? undefined : { baseline: projectBaseline, value: next },
  });
}

export function applyProductionProjectDraft(current: ProductionProjectSettings, draft?: StageConfigurationDraft): { settings: ProductionProjectSettings; conflicts: string[] } {
  if (!draft?.project) return { settings: current, conflicts: [] };
  const { baseline, value } = draft.project;
  const settings = { ...current }, conflicts: string[] = [];
  for (const field of ['brief', 'style', 'profile'] as const) {
    if (sameContent(baseline[field], value[field])) continue;
    if (!sameContent(current[field], baseline[field]) && !sameContent(current[field], value[field])) conflicts.push(field);
    else Object.assign(settings, { [field]: value[field] });
  }
  return { settings, conflicts };
}

export function applyStageConfigurationDraft(workflow: WorkflowDefinition, draft: StageConfigurationDraft | undefined): { workflow: WorkflowDefinition; conflicts: string[] } {
  if (!draft?.changes.length && !draft?.production) return { workflow, conflicts: [] };
  const changes = new Map(draft!.changes.map(change => [change.node.id, change]));
  const currentIds = new Set(workflow.nodes.map(node => node.id));
  const conflicts = draft!.changes.filter(change => !currentIds.has(change.node.id)).map(change => change.node.id);
  let changed = false;
  const nodes = workflow.nodes.map(node => {
    const pending = changes.get(node.id);
    if (!pending || sameContent(node, pending.node)) return node;
    if (!sameContent(node, pending.baseline)) { conflicts.push(node.id); return node; }
    changed = true;
    return pending.node;
  });
  let production = workflow.production;
  if (draft?.production) {
    if (sameContent(production, draft.production.baseline) || sameContent(production, draft.production.value)) { production = draft.production.value; changed = true; }
    else conflicts.push('production');
  }
  return { workflow: changed ? resolveProductionWorkflow({ ...workflow, nodes, production }) : workflow, conflicts };
}
