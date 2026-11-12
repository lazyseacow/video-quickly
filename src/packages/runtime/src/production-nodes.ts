import { usesManualPlanning, type ProjectDocument, type RunSelection, type WorkflowDefinition, type WorkflowNode } from '@video-quickly/contracts';
import { withAutomaticCasting } from './automatic-casting.js';

export function orderedNodes(workflow: WorkflowDefinition): WorkflowNode[] {
  const remaining = new Map(workflow.nodes.map(node => [node.id, node]));
  const completed = new Set<string>();
  const ordered: WorkflowNode[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(node => workflow.edges.filter(edge => edge.target === node.id).every(edge => completed.has(edge.source)));
    if (!ready.length) throw new Error('流程存在循环依赖，请检查连接。');
    for (const node of ready) { remaining.delete(node.id); completed.add(node.id); ordered.push(node); }
  }
  return ordered;
}

function productionNodeForRun(workflow: WorkflowDefinition, node: WorkflowNode): WorkflowNode {
  if (!usesManualPlanning(workflow, node)) return node;
  return { ...node, modelId: undefined, skillIds: [], config: { ...node.config, requiresModel: false } };
}

function selectNodes(workflow: WorkflowDefinition, nodeId?: string, selection?: RunSelection) {
  if (nodeId) return workflow.nodes.filter(node => node.id === nodeId).map(node => productionNodeForRun(workflow, node));
  const nodes = orderedNodes(workflow).map(node => productionNodeForRun(workflow, node));
  if (!selection) return nodes;
  if (!workflow.nodes.some(node => node.id === selection.nodeId)) throw new Error('未找到所选步骤，请重新打开执行范围。');
  const ids = new Set([selection.nodeId]);
  if (selection.mode === 'downstream') for (const id of ids) {
    for (const edge of workflow.edges) if (edge.source === id) ids.add(edge.target);
  }
  return nodes.filter(node => ids.has(node.id));
}

interface ProductionNodeOptions {
  nodeId?: string;
  selection?: RunSelection;
  editingAgent?: () => WorkflowNode | undefined;
  automaticCasting?: boolean;
  exportDestination?: string;
}

export function resolveProductionNodes(project: ProjectDocument, options: ProductionNodeOptions = {}) {
  const { nodeId, selection, editingAgent, automaticCasting, exportDestination } = options;
  const fullProduction = !nodeId && !selection;
  const selected = selectNodes(project.workflow, nodeId, selection);
  const agent = fullProduction ? editingAgent?.() : undefined;
  const nodes = selected.map(node => {
    if (agent && node.id === agent.id) return agent;
    if (exportDestination && node.kind === 'export') return { ...node, config: { ...node.config, destination: exportDestination } };
    return node;
  });
  return { nodes: fullProduction && automaticCasting ? withAutomaticCasting(project, nodes) : nodes, agent };
}
