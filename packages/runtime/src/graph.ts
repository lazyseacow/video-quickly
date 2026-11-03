import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { JsonValue, WorkflowDefinition, WorkflowNode } from '@video-quickly/contracts';
import type Database from 'better-sqlite3';

const ExecutionState = Annotation.Root({
  completed: Annotation<string[]>({ reducer: (_, value) => value, default: () => [] }),
  skipped: Annotation<string[]>({ reducer: (_, value) => value, default: () => [] }),
  currentNodeId: Annotation<string>({ reducer: (_, value) => value, default: () => '' }),
  outputs: Annotation<Record<string, JsonValue>>({ reducer: (previous, next) => ({ ...previous, ...next }), default: () => ({}) }),
});

export interface GraphCallbacks {
  execute(node: WorkflowNode): Promise<JsonValue>;
  advanced(node: WorkflowNode): void;
}

function conditionMatches(condition: string | undefined, output: JsonValue | undefined): boolean {
  if (!condition) return true;
  const values = output && typeof output === 'object' && !Array.isArray(output) ? output : undefined;
  const declared = values?.outputs && typeof values.outputs === 'object' && !Array.isArray(values.outputs) ? values.outputs : undefined;
  const matched = values?.matched ?? declared?.matched;
  if (['true', 'yes', 'matched'].includes(condition)) return matched === true;
  if (['false', 'no', 'unmatched'].includes(condition)) return matched === false;
  return false;
}

export function createExecutionGraph(database: Database.Database, workflow: WorkflowDefinition, callbacks: GraphCallbacks) {
  const nodes = workflow.nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const checkpointer = new SqliteSaver(database);
  const builder = new StateGraph(ExecutionState)
    .addNode('dispatch', state => {
      const skipped = new Set(state.skipped);
      const completed = new Set(state.completed);
      let currentNodeId = '';
      // One local project schedules one activity at a time; dependencies and
      // branch predicates remain native persisted graph state.
      for (const node of nodes) {
        if (completed.has(node.id) || skipped.has(node.id)) continue;
        const incoming = workflow.edges.filter(edge => edge.target === node.id);
        if (!incoming.every(edge => completed.has(edge.source) || skipped.has(edge.source))) continue;
        const reachable = incoming.length === 0 || incoming.some(edge => completed.has(edge.source) && conditionMatches(edge.condition, state.outputs[edge.source]));
        if (!reachable) { skipped.add(node.id); continue; }
        currentNodeId = node.id; break;
      }
      if (!currentNodeId && completed.size + skipped.size < nodes.length) throw new Error('流程依赖无法继续，请检查汇合与条件连接。');
      return { currentNodeId, skipped: [...skipped] };
    })
    .addNode('execute', async state => {
      const node = byId.get(state.currentNodeId);
      if (!node) throw new Error('步骤不存在。');
      const result = await callbacks.execute(node);
      callbacks.advanced(node);
      return { outputs: { [node.id]: result }, completed: [...state.completed, node.id] };
    })
    .addEdge(START, 'dispatch')
    .addConditionalEdges('dispatch', state => !state.currentNodeId ? END : 'execute')
    .addEdge('execute', 'dispatch');
  return builder.compile({ checkpointer });
}
