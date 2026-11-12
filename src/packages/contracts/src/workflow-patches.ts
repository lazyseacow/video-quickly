import { z } from 'zod';
import type { ProjectDocument } from './index.js';
import { workflowNodeSchema, type WorkflowNode } from './workflow-schema.js';

export const workflowNodePatchSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().max(200000).optional(),
  modelId: z.string().min(1).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, '修改建议不能为空。');
export const workflowProposalSchema = z.object({
  projectId: z.string().min(1), projectRevision: z.number().int().positive(),
  baseline: z.lazy(() => workflowNodeSchema), patch: workflowNodePatchSchema,
  summary: z.string().trim().min(1).max(2000),
}).strict();
export type WorkflowProposal = z.infer<typeof workflowProposalSchema>;
export const workflowAssistantContextSchema = z.object({
  projectId: z.string().min(1), projectRevision: z.number().int().positive(), baseline: z.lazy(() => workflowNodeSchema),
  instruction: z.string().trim().min(1).max(10000), allowedModelIds: z.array(z.string().min(1)),
}).strict();
export type WorkflowAssistantContext = z.infer<typeof workflowAssistantContextSchema>;

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  const leftKeys = Object.keys(left).filter(key => Reflect.get(left, key) !== undefined);
  const rightKeys = Object.keys(right).filter(key => Reflect.get(right, key) !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameValue(Reflect.get(left, key), Reflect.get(right, key)));
}

/** Compare the complete node, including fields the assistant cannot change. */
export function applyWorkflowProposal(project: Pick<ProjectDocument, 'id' | 'revision'>, current: WorkflowNode, input: WorkflowProposal): WorkflowNode {
  const proposal = workflowProposalSchema.parse(input);
  if (project.id !== proposal.projectId || project.revision !== proposal.projectRevision) throw new Error('项目已修改，请基于当前修订重新生成建议。');
  if (!sameValue(workflowNodeSchema.parse(current), proposal.baseline)) throw new Error('任务已修改，请保留当前草稿并重新生成建议。');
  const { modelId, ...patch } = proposal.patch;
  return workflowNodeSchema.parse({ ...current, ...patch, ...(Object.hasOwn(proposal.patch, 'modelId') ? { modelId: modelId ?? undefined } : {}) });
}

export function workflowProposalChanges(proposal: WorkflowProposal) {
  const next = applyWorkflowProposal({ id: proposal.projectId, revision: proposal.projectRevision }, proposal.baseline, proposal);
  return (['label', 'prompt', 'modelId'] as const).filter(field => proposal.baseline[field] !== next[field]).map(field => ({
    field, label: { label: '任务名称', prompt: '提示词', modelId: '生成模型' }[field],
    before: proposal.baseline[field] ?? '', after: next[field] ?? '',
  }));
}
