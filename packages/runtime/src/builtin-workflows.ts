import { createVideoWorkflow, type ProjectDocument, type WorkflowDefinition } from '@video-quickly/contracts';

export function upgradeBuiltinWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  if (!['history-handdrawn', 'general-video'].includes(workflow.id)) return workflow;
  const removed = new Set(workflow.nodes.filter(node => node.kind === 'research' || node.kind === 'review').map(node => node.id));
  const nodes = workflow.nodes.filter(node => !removed.has(node.id)).map(node => node.requiresReview ? { ...node, requiresReview: false } : node);
  if (!nodes.length) return workflow;
  let edges = workflow.edges;
  for (const id of removed) {
    const incoming = edges.filter(edge => edge.target === id), outgoing = edges.filter(edge => edge.source === id);
    edges = edges.filter(edge => edge.source !== id && edge.target !== id);
    for (const before of incoming) for (const after of outgoing) {
      const condition = before.condition ?? after.condition;
      if (before.source === after.target || edges.some(edge => edge.source === before.source && edge.target === after.target && edge.condition === condition)) continue;
      const base = `${before.source}-${after.target}`;
      let edgeId = base, suffix = 1;
      while (edges.some(edge => edge.id === edgeId)) edgeId = `${base}-${suffix++}`;
      edges.push({ id: edgeId, source: before.source, target: after.target, ...(condition === undefined ? {} : { condition }) });
    }
  }
  const defaults = createVideoWorkflow().stages ?? [];
  const stageByKind = new Map(defaults.flatMap(stage => stage.nodeIds.map(kind => [kind, stage.id] as const)));
  const stages = workflow.stages?.map(stage => ({ ...stage, nodeIds: stage.nodeIds.filter(id => !removed.has(id)) })).filter(stage => stage.nodeIds.length)
    ?? defaults.map(stage => ({ ...stage, nodeIds: nodes.filter(node => (stageByKind.get(node.kind) ?? defaults[0]?.id) === stage.id).map(node => node.id) })).filter(stage => stage.nodeIds.length);
  if (!removed.size && nodes.every((node, index) => node === workflow.nodes[index]) && JSON.stringify(stages) === JSON.stringify(workflow.stages)) return workflow;
  return { ...workflow, version: workflow.version + 1, nodes, edges, stages };
}

export function upgradeBuiltinProject(project: ProjectDocument): ProjectDocument {
  const workflow = upgradeBuiltinWorkflow(project.workflow);
  return workflow === project.workflow ? project : { ...project, revision: project.revision + 1, workflow };
}
