import { createVideoWorkflow, resolveWorkflowStages, type ResolvedWorkflowStage, type WorkflowDefinition } from '@video-quickly/contracts';

export function resolveWorkbenchStages(workflow: WorkflowDefinition): ResolvedWorkflowStage[] | undefined {
  if (workflow.stages?.length) return resolveWorkflowStages(workflow);
  if (workflow.id !== 'history-handdrawn') return;

  // Present legacy tasks in the same four stages without changing the saved graph.
  const stages = createVideoWorkflow().stages ?? [];
  const stageByKind = new Map(stages.flatMap(stage => stage.nodeIds.map(kind => [kind, stage.id] as const)));
  // Frozen pre-upgrade runs can still contain the removed review task.
  stageByKind.set('review', 'delivery');
  const planning = stages[0]?.id;
  return resolveWorkflowStages({ ...workflow, stages: stages.map(stage => ({
    ...stage,
    nodeIds: workflow.nodes.filter(node => (stageByKind.get(node.kind) ?? planning) === stage.id).map(node => node.id),
  })) });
}
