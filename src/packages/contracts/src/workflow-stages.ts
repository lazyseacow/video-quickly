import type { WorkflowDefinition, WorkflowNode, WorkflowStage } from './index.js';

export interface ResolvedWorkflowStage extends WorkflowStage { nodes: WorkflowNode[]; }

/** Stages organize related settings; nodes and edges remain the execution contract. */
export function resolveWorkflowStages(workflow: WorkflowDefinition): ResolvedWorkflowStage[] {
  const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
  const assigned = new Set<string>();
  const stages: ResolvedWorkflowStage[] = [];
  for (const stage of workflow.stages ?? []) {
    const selected: WorkflowNode[] = [];
    for (const id of stage.nodeIds) {
      const node = nodes.get(id);
      if (!node || assigned.has(id)) continue;
      assigned.add(id); selected.push(node);
    }
    // Graph editing can remove tasks or add custom ones. Keep every remaining
    // task reachable without rewriting existing saved workflow metadata.
    if (selected.length) stages.push({ ...stage, nodeIds: selected.map(node => node.id), nodes: selected });
  }
  for (const node of workflow.nodes) {
    if (!assigned.has(node.id)) stages.push({ id: node.id, label: node.label, description: node.description, nodeIds: [node.id], nodes: [node] });
  }
  return stages;
}
