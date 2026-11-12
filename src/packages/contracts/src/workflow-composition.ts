import type { JsonValue, SubflowDefinition, SubflowReference, WorkflowDefinition, WorkflowNode } from './index.js';

export const subflowNodeId = (parentId: string, childId: string) => `${parentId}/subflow/${encodeURIComponent(childId)}`;
export const subflowThreadId = (runId: string, nodeId: string) => `${runId}:subflow:${nodeId}`;
const key = (value: { id: string; version: number }) => `${value.id}@${value.version}`;
export function subflowValueAt(value: JsonValue | undefined, path: readonly string[]): JsonValue {
  let current = value;
  for (const segment of path) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment) || current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) throw new Error('子流程契约引用的产物字段不存在。');
    current = Array.isArray(current) ? current[Number(segment)] : current[segment];
  }
  if (current === undefined) throw new Error('子流程契约引用的产物尚未保存。');
  return current;
}
export function resolveSubflowInputs(definition: SubflowDefinition, reference: SubflowReference, read: (nodeId: string) => JsonValue | undefined): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const input of definition.inputs) {
    const binding = reference.inputs[input.name];
    const value = binding ? 'literal' in binding ? binding.literal : subflowValueAt(read(binding.nodeId), binding.path) : input.default;
    if (value === undefined) { if (input.required) throw new Error(`请填写子流程输入：${input.name}`); continue; }
    if (input.type !== 'json' && typeof value !== input.type) throw new Error(`子流程输入 ${input.name} 的类型须为 ${input.type}。`);
    values[input.name] = structuredClone(value);
  }
  for (const name of Object.keys(reference.inputs)) if (!definition.inputs.some(input => input.name === name)) throw new Error(`子流程没有声明输入：${name}`);
  return values;
}
export function substituteSubflowInputs(value: JsonValue, inputs: Record<string, JsonValue>): JsonValue {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{input\.([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1];
    if (exact) { if (!Object.hasOwn(inputs, exact)) throw new Error(`子流程输入未提供：${exact}`); return structuredClone(inputs[exact]); }
    return value.replace(/\{\{input\.([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, name: string) => { if (!Object.hasOwn(inputs, name)) throw new Error(`子流程输入未提供：${name}`); const input = inputs[name]; return typeof input === 'string' ? input : JSON.stringify(input); });
  }
  if (Array.isArray(value)) return value.map(item => substituteSubflowInputs(item, inputs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, substituteSubflowInputs(item, inputs)]));
  return value;
}
export function workflowNodesWithSubflows(workflow: WorkflowDefinition): WorkflowNode[] {
  const definitions = new Map((workflow.subflows ?? []).map(item => [key(item), item]));
  let count = 0;
  function visit(nodes: WorkflowNode[], prefix?: string, trail: string[] = []): WorkflowNode[] {
    if (trail.length > 8) throw new Error('子流程嵌套不能超过 8 层。');
    return nodes.flatMap(original => {
      if (++count > 1000) throw new Error('展开后的子流程步骤不能超过 1000 个，请拆分流程。');
      const node = prefix ? { ...original, id: subflowNodeId(prefix, original.id), subflow: original.subflow ? { ...original.subflow, inputs: Object.fromEntries(Object.entries(original.subflow.inputs).map(([name, binding]) => [name, 'literal' in binding ? binding : { ...binding, nodeId: subflowNodeId(prefix, binding.nodeId) }])) } : undefined } : original;
      if (node.kind !== 'subflow') return [node];
      const definition = node.subflow && definitions.get(key(node.subflow));
      if (!definition) throw new Error('子流程的固定版本不存在，请重新插入。');
      if (trail.includes(key(definition))) throw new Error('子流程包含递归引用。');
      return [node, ...visit(definition.nodes, node.id, [...trail, key(definition)])];
    });
  }
  const nodes = visit(workflow.nodes);
  if (nodes.length > 1000 || new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('展开后的子流程步骤超过 1000 个或命名空间冲突。');
  return nodes;
}
export function validateWorkflowComposition(workflow: WorkflowDefinition): void {
  workflowNodesWithSubflows(workflow);
  const definitions = new Map((workflow.subflows ?? []).map(item => [key(item), item]));
  if (definitions.size !== (workflow.subflows ?? []).length) throw new Error('子流程存在重复的版本定义。');
  const validate = (nodes: WorkflowNode[], edges: WorkflowDefinition['edges'], trail: string[], parentInputs = new Map<string, string>()) => {
    const ids = new Set(nodes.map(node => node.id));
    if (ids.size !== nodes.length) throw new Error('流程包含重复的步骤 ID。');
    if (edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) throw new Error('流程连接引用了不存在的步骤。');
    const completed = new Set<string>();
    while (completed.size !== nodes.length) {
      const ready = nodes.filter(node => !completed.has(node.id) && edges.filter(edge => edge.target === node.id).every(edge => completed.has(edge.source)));
      if (!ready.length) throw new Error('流程存在循环依赖，请检查连接。');
      ready.forEach(node => completed.add(node.id));
    }
    for (const node of nodes) {
      if (node.kind !== 'subflow') { if (node.subflow) throw new Error('只有子流程步骤可以引用固定版本。'); continue; }
      if (typeof node.config.inputBindingsDraft === 'string') throw new Error('子流程输入绑定仍有未解析的草稿，请修正后保存。');
      const reference = node.subflow, definition = reference && definitions.get(key(reference));
      if (!reference || !definition) throw new Error('子流程的固定版本不存在，请重新插入。');
      if (trail.includes(key(definition)) || trail.length >= 8) throw new Error('子流程包含递归引用或超过 8 层嵌套。');
      for (const name of Object.keys(reference.inputs)) if (!definition.inputs.some(input => input.name === name)) throw new Error(`子流程没有声明输入：${name}`);
      for (const input of definition.inputs) {
        const binding = reference.inputs[input.name], value = binding && 'literal' in binding ? binding.literal : input.default;
        if (!binding && value === undefined && input.required) throw new Error(`请填写子流程输入：${input.name}`);
        const parameter = trail.length && typeof value === 'string' ? value.match(/^\{\{input\.([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1] : undefined;
        if (parameter) {
          const sourceType = parentInputs.get(parameter);
          if (!sourceType) throw new Error(`子流程没有声明输入：${parameter}`);
          if (input.type !== 'json' && sourceType !== input.type) throw new Error(`子流程输入 ${input.name} 的类型须为 ${input.type}。`);
        } else if (value !== undefined && input.type !== 'json' && typeof value !== input.type) throw new Error(`子流程输入 ${input.name} 的类型须为 ${input.type}。`);
      }
      for (const binding of Object.values(reference.inputs)) if ('nodeId' in binding) {
        const ancestors = new Set(edges.filter(edge => edge.target === node.id).map(edge => edge.source));
        for (const id of ancestors) edges.filter(edge => edge.target === id).forEach(edge => ancestors.add(edge.source));
        if (!ancestors.has(binding.nodeId)) throw new Error('子流程输入只能引用其上游步骤的产物。');
      }
      if (new Set(definition.inputs.map(input => input.name)).size !== definition.inputs.length || new Set(definition.outputs.map(output => output.name)).size !== definition.outputs.length) throw new Error('子流程输入输出名称不能重复。');
      if (definition.outputs.some(output => !definition.nodes.some(child => child.id === output.nodeId))) throw new Error('子流程输出引用了不存在的步骤。');
      validate(definition.nodes, definition.edges, [...trail, key(definition)], new Map(definition.inputs.map(input => [input.name, input.type])));
    }
  };
  validate(workflow.nodes, workflow.edges, []);
}

export function workflowEdgesWithSubflows(workflow: WorkflowDefinition): WorkflowDefinition['edges'] {
  workflowNodesWithSubflows(workflow);
  const definitions = new Map((workflow.subflows ?? []).map(definition => [key(definition), definition]));
  const collect = (nodes: WorkflowNode[], edges: WorkflowDefinition['edges'], prefix?: string): WorkflowDefinition['edges'] => [
    ...edges.map(edge => prefix ? { ...edge, id: subflowNodeId(prefix, edge.id), source: subflowNodeId(prefix, edge.source), target: subflowNodeId(prefix, edge.target) } : edge),
    ...nodes.flatMap(node => {
      if (!node.subflow || node.kind !== 'subflow') return [];
      const definition = definitions.get(key(node.subflow))!;
      return collect(definition.nodes, definition.edges, prefix ? subflowNodeId(prefix, node.id) : node.id);
    }),
  ];
  return collect(workflow.nodes, workflow.edges);
}
