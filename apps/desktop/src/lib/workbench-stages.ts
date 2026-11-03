import { resolveWorkflowStages, type ResolvedWorkflowStage, type WorkflowDefinition } from '@video-quickly/contracts';

export function resolveWorkbenchStages(workflow: WorkflowDefinition): ResolvedWorkflowStage[] | undefined {
  return workflow.stages?.length ? resolveWorkflowStages(workflow) : undefined;
}
