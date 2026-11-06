import type { SkillPackage, WorkflowNode } from './index.js';

export function supportsSkillScript(path: string): boolean { return /\.(?:js|mjs|cjs)$/i.test(path); }

export function skillPromptContext(node: Pick<WorkflowNode, 'skillIds'>, skills: SkillPackage[]): string {
  const selected = skills.filter(skill => skill.enabled && node.skillIds.includes(skill.id));
  if (!selected.length) return '';
  return [
    '本任务选用以下 Skill。根据当前任务采用相关的创作方法、风格和约束；最终交付格式遵循本步骤的输出规范。',
    ...selected.map(skill => [
      `Skill ${skill.name} · ${skill.version}:\n${skill.instructions}`,
      ...(skill.resources.length ? [`资源目录：${skill.resources.join('、')}`] : []),
      ...Object.entries(skill.referenceContents ?? {}).map(([path, content]) => `Skill ${skill.name} 引用资源 ${path}:\n${content}`),
    ].join('\n\n')),
  ].join('\n\n');
}

export function appendSkillContext(prompt: string, node: Pick<WorkflowNode, 'skillIds'>, skills: SkillPackage[]): string {
  return [prompt, skillPromptContext(node, skills)].filter(Boolean).join('\n\n');
}
