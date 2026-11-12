import { createNativeVideoWorkflow, resolveWorkflowStages, type ResolvedWorkflowStage, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';

const nativeWorkflow = createNativeVideoWorkflow();
export const nativeWorkbenchStages = nativeWorkflow.stages!;

export function stageTaskId(kind: WorkflowNode['kind'], editing: boolean) {
  return kind === 'animation' ? editing ? 'animation' : 'video' : kind;
}

export function resolveWorkbenchStages(workflow: WorkflowDefinition): ResolvedWorkflowStage[] | undefined {
  if (workflow.id === nativeWorkflow.id) return nativeWorkbenchStages.map(stage => {
    const nodes = workflow.nodes.filter(node => {
      const role = nativeWorkflow.nodes.some(nativeNode => nativeNode.id === node.id) ? node.id : stageTaskId(node.kind, node.config.operation === 'prepare-edit');
      return stage.nodeIds.includes(role);
    });
    return { ...stage, nodeIds: nodes.map(node => node.id), nodes };
  });
  return workflow.stages?.length ? resolveWorkflowStages(workflow) : undefined;
}

export function generationLabel(label: string): string {
  const labels: Record<string, string> = { '创意简报': '简报生成', '风格与角色': '风格与角色生成', '旁白与分镜': '分镜生成', '参考素材准备': '参考图生成' };
  return labels[label] ?? label;
}
