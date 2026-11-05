import { isModelGenerationNode, resolveWorkflowStages, type ResolvedWorkflowStage, type WorkflowDefinition } from '@video-quickly/contracts';

export function resolveWorkbenchStages(workflow: WorkflowDefinition): ResolvedWorkflowStage[] | undefined {
  return workflow.stages?.length ? resolveWorkflowStages(workflow) : undefined;
}

export function generationLabel(label: string): string {
  const labels: Record<string, string> = { '创意简报': '简报生成', '风格与角色': '风格与角色生成', '旁白与分镜': '分镜生成', '参考素材准备': '参考图生成' };
  return labels[label] ?? label;
}

export function resolveGenerationSteps(workflow: WorkflowDefinition): ResolvedWorkflowStage[] {
  return workflow.nodes.filter(isModelGenerationNode).map(node => ({ id: `task:${node.id}`, label: generationLabel(node.label), description: node.description, nodeIds: [node.id], nodes: [node] }));
}
