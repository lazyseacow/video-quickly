import { expect, it } from 'vitest';
import { applyPromptLibraryItem, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, promptBindingsSchema, promptLibraryItemSchema, resolvePromptBindings, shotSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { buildWorkflowPrompt } from '../packages/runtime/src/workflow-prompts';

const project = projectSchema.parse({ id: 'binding-project', revision: 1, title: '花园故事', brief: '小青找到木盒', style: '水彩', workflow: createNativeVideoWorkflow(), profile: DEFAULT_VIDEO_PROFILE, shots: [], createdAt: '', updatedAt: '' });
const shot = shotSchema.parse({ id: 'first', title: '木盒', narration: '盒子在这里。', visualPrompt: '木盒特写', durationUs: 2000000 });
const node = workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', prompt: '{{theme}} / {{width}} / {{voice}} / {{facts}} / {{prior}}', promptBindings: { theme: { projectPath: ['title'] }, width: { projectPath: ['profile', 'width'] }, voice: { shotPath: ['narration'] }, facts: { literal: { count: 2, available: true } }, prior: { nodeId: 'source', path: ['text'] } } });
it('resolves literal JSON and restricted paths through the shared binding resolver', () => {
  const resolved = resolvePromptBindings(node, project, shot, { source: { text: '已保存的证据' } });
  expect(resolved.prompt).toBe('花园故事 / 1920 / 盒子在这里。 / {"count":2,"available":true} / 已保存的证据');
  expect(resolved.variables.map(variable => variable.source)).toEqual(['项目.title', '项目.profile.width', '镜头.narration', '字面值', '上游 source.text']);
  const prompt = buildWorkflowPrompt({ ...project, shots: [shot] }, node, [], false, [], [{ nodeId: 'source', label: '证据', kind: 'brief', output: { text: '已保存的证据' } }]);
  expect(prompt).toContain(resolved.prompt);
});
it('keeps templates as data, rejects unsafe paths and missing bindings without evaluating expressions', () => {
  expect(() => promptBindingsSchema.parse({ unsafe: { projectPath: ['__proto__', 'value'] } })).toThrow();
  for (const prompt of ['{{theme.toUpperCase()}}', '{{process.env}}', '{{missing}}']) expect(() => resolvePromptBindings({ ...node, prompt }, project, shot, { source: { text: 'data' } })).toThrow('未绑定');
  expect(() => resolvePromptBindings({ ...node, promptBindings: { secret: { projectPath: ['workflow', 'nodes'] } } }, project)).toThrow('不支持');
  expect(() => resolvePromptBindings(node, project)).toThrow('选择一个镜头');
  const legacy = { ...node, prompt: '{{unknown}} stays literal', promptBindings: undefined };
  expect(resolvePromptBindings(legacy, project).prompt).toBe(legacy.prompt);
  const literal = { ...node, prompt: '{{text}}', promptBindings: { text: { literal: '{{process.exit()}}' } } };
  expect(resolvePromptBindings(literal, project).prompt).toBe('{{process.exit()}}');
});
it('applies fixed template content explicitly and protects variable bindings when appending', () => {
  const item = promptLibraryItemSchema.parse({ id: 'template', revision: 1, version: 1, kind: 'snippet', name: '节奏', prompt: '{{pace}}', bindings: { pace: { literal: '慢一些' } }, nodeKinds: ['brief'], createdAt: '', updatedAt: '' });
  const updated = applyPromptLibraryItem(node, item, 'append');
  expect(updated.prompt).toBe(`${node.prompt}\n\n{{pace}}`); expect(updated.promptTemplate).toEqual({ id: item.id, version: 1 }); expect(node.promptBindings).not.toHaveProperty('pace');
  expect(applyPromptLibraryItem(node, item, 'replace').promptBindings).toEqual(item.bindings);
  expect(() => applyPromptLibraryItem({ ...node, promptBindings: { pace: { literal: '快一些' } } }, item, 'append')).toThrow('不同绑定');
  expect(() => applyPromptLibraryItem({ ...node, kind: 'script' }, item, 'replace')).toThrow('不适用');
});
