import type { JsonValue, PromptBindings, PromptLibraryItem, ProjectDocument, Shot, WorkflowNode } from './index.js';
import { subflowValueAt } from './workflow-composition.js';
import { isVideoGenerationNode } from './production.js';

export function supportsPromptExperiment(node: Pick<WorkflowNode, 'kind' | 'config'>): boolean {
  return ['brief', 'style', 'script', 'assets'].includes(node.kind) || isVideoGenerationNode(node);
}

export function resolvePromptBindings(node: WorkflowNode, project: ProjectDocument, shot?: Shot, upstream: Record<string, JsonValue> = {}) {
  if (!node.promptBindings) return { prompt: node.prompt, variables: [] };
  const variables = Object.entries(node.promptBindings).map(([name, binding]) => {
    let source: string, value: JsonValue;
    if ('literal' in binding) { source = '字面值'; value = binding.literal; }
    else if ('projectPath' in binding) {
      if (!['title', 'brief', 'style', 'profile', 'creativeContext'].includes(binding.projectPath[0])) throw new Error(`变量 ${name} 不支持此项目字段。`);
      source = `项目.${binding.projectPath.join('.')}`; value = subflowValueAt(project as unknown as JsonValue, binding.projectPath);
    } else if ('shotPath' in binding) {
      if (!shot) throw new Error(`变量 ${name} 需要选择一个镜头。`);
      if (!['id', 'title', 'narration', 'visualPrompt', 'soundPrompt', 'durationUs'].includes(binding.shotPath[0])) throw new Error(`变量 ${name} 不支持此镜头字段。`);
      source = `镜头.${binding.shotPath.join('.')}`; value = subflowValueAt(shot as unknown as JsonValue, binding.shotPath);
    } else { source = `上游 ${binding.nodeId}.${binding.path.join('.')}`; value = subflowValueAt(upstream[binding.nodeId], binding.path); }
    return { name, source, value };
  });
  const values = new Map(variables.map(variable => [variable.name, variable.value]));
  const prompt = node.prompt.replace(/\{\{([\s\S]*?)\}\}/g, (_, name: string) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !values.has(name)) throw new Error(`提示词变量「${name}」未绑定，只支持 {{变量名}}。`);
    const value = values.get(name)!;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  if (prompt.length > 200000) throw new Error('解析后的提示词超过 200000 字符，请减少输入。');
  return { prompt, variables };
}

export function applyPromptLibraryItem(node: WorkflowNode, item: PromptLibraryItem, mode: 'append' | 'replace'): WorkflowNode {
  if (item.archived || !item.nodeKinds.includes(node.kind)) throw new Error('此提示词不适用于当前任务。');
  const bindings: PromptBindings = mode === 'replace' ? { ...item.bindings } : { ...node.promptBindings, ...item.bindings };
  if (mode === 'append') for (const name of Object.keys(item.bindings ?? {})) {
    if (Object.hasOwn(node.promptBindings ?? {}, name) && JSON.stringify(node.promptBindings![name]) !== JSON.stringify(item.bindings![name])) throw new Error(`变量 ${name} 已存在不同绑定，请重命名后追加。`);
  }
  return { ...node, prompt: mode === 'replace' ? item.prompt : [node.prompt, item.prompt].filter(Boolean).join('\n\n'),
    promptBindings: Object.keys(bindings).length ? bindings : undefined, promptTemplate: { id: item.id, version: item.version } };
}
