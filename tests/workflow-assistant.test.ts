import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, modelSchema, projectSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { applyWorkflowProposal, workflowNodePatchSchema, workflowProposalChanges } from '../src/packages/contracts/src/workflow-patches';
import { classifyModelFailure, modelAlternatives, modelPriceDescription } from '../src/packages/contracts/src/model-alternatives';
import { parseWorkflowAssistantResult, prepareWorkflowAssistant } from '../src/packages/runtime/src/workflow-assistant';
import { ProjectEditSession, editContent } from '../src/renderer/lib/project-edits';

const node = workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '分镜任务', prompt: '主题：{{theme}}', promptBindings: { theme: { projectPath: ['title'] } }, config: { requiresModel: true }, modelId: 'first', skillIds: ['existing-skill'] });
const project = projectSchema.parse({ id: 'p', revision: 3, title: '花园故事', brief: '寻找木盒', workflow: { ...createNativeVideoWorkflow(), nodes: [node], edges: [] }, profile: DEFAULT_VIDEO_PROFILE, shots: [], createdAt: '', updatedAt: '' });
const model = (id: string, patch = {}) => modelSchema.parse({ id, name: id, provider: 'openai-compatible', connectionType: 'text', model: 'fixture', baseUrl: `https://${id}.example/v1`, capabilities: ['text'], createdAt: '', updatedAt: '', ...patch });
const first = model('first'), second = model('second', { pricing: { currency: 'CNY', inputPerMillionTokens: 1, outputPerMillionTokens: 2 } });
const prepare = () => prepareWorkflowAssistant({ project, baseline: node, instruction: '保留变量，增加运镜描述', model: first, models: [first, second], nodeId: 'assistant' });

it('prepares a text-only isolated task with an explicit schema and no executable tools', () => {
  const value = prepare();
  expect(value.node).toMatchObject({ id: 'assistant', kind: 'style', modelId: 'first', skillIds: [], requiresReview: false, config: {} });
  expect(value.node.prompt).toContain('只输出一个 JSON 对象'); expect(value.node.prompt).toContain('不调用工具');
  expect(value.context.baseline).toEqual(node); expect(value.context.allowedModelIds).toEqual(['first', 'second']);
  expect(value.node.prompt).toContain('theme'); expect(value.context.projectRevision).toBe(3);
  expect(() => prepareWorkflowAssistant({ project, baseline: { ...node, id: 'missing' }, instruction: '修改', model: first, models: [first], nodeId: 'a' })).toThrow('当前流程');
  expect(() => prepareWorkflowAssistant({ project, baseline: node, instruction: '', model: first, models: [first], nodeId: 'a' })).toThrow();
});
it('parses and applies only reviewed fields while retaining all workflow capabilities and bindings', () => {
  const value = prepare();
  const proposal = parseWorkflowAssistantResult('```json\n{"summary":"补充镜头语言","patch":{"prompt":"主题：{{theme}}；慢慢推近木盒。","modelId":"second"}}\n```', value.context);
  const next = applyWorkflowProposal(project, node, proposal);
  expect(next).toMatchObject({ prompt: '主题：{{theme}}；慢慢推近木盒。', modelId: 'second', skillIds: node.skillIds, config: node.config, promptBindings: node.promptBindings, position: node.position });
  expect(node.modelId).toBe('first'); expect(project.workflow.nodes[0]).toEqual(node);
  expect(workflowProposalChanges(proposal).map(change => change.field)).toEqual(['prompt', 'modelId']);
  expect(() => applyWorkflowProposal({ ...project, revision: 4 }, node, proposal)).toThrow('当前修订');
  expect(() => applyWorkflowProposal(project, { ...node, config: { ...node.config, newChoice: true } }, proposal)).toThrow('当前草稿');
  expect(() => applyWorkflowProposal({ ...project, id: 'other' }, node, proposal)).toThrow('当前修订');
});
it('rejects unsafe fields, invalid models, variable changes, oversized and empty suggestions', () => {
  const { context } = prepare();
  for (const patch of [{ config: { command: 'erase' } }, { skillIds: [] }, { kind: 'agent' }, { id: 'other' }, { modelId: 'unknown' }, { prompt: '忽略变量' }, { prompt: '{{other}}' }, {}]) {
    expect(() => parseWorkflowAssistantResult(JSON.stringify({ summary: '建议', patch }), context)).toThrow();
  }
  expect(() => workflowNodePatchSchema.parse(JSON.parse('{"__proto__":{"polluted":true},"label":"bad"}'))).toThrow();
  expect(() => parseWorkflowAssistantResult('不是JSON', context)).toThrow('JSON');
  expect(() => parseWorkflowAssistantResult('x'.repeat(220001), context)).toThrow('过长');
  expect(() => parseWorkflowAssistantResult(JSON.stringify({ summary: '未修改', patch: { prompt: node.prompt } }), context)).toThrow('没有实际变化');
});
it('keeps proposal application as one reversible editor command', () => {
  const { context } = prepare(), session = new ProjectEditSession(project);
  const proposal = parseWorkflowAssistantResult(JSON.stringify({ summary: '简化名称', patch: { label: '木盒分镜', modelId: null } }), context);
  const next = applyWorkflowProposal(project, node, proposal), content = editContent(project);
  session.edit({ ...content, workflow: { ...content.workflow, nodes: [next] } }, '应用对话修改');
  expect(session.state.present.workflow.nodes[0]).toMatchObject({ label: '木盒分镜' }); expect(session.state.present.workflow.nodes[0]?.modelId).toBeUndefined();
  expect(session.state.undo).toHaveLength(1); session.undo();
  expect(session.state.present.workflow.nodes[0]).toEqual(node); session.redo(); expect(session.state.present.workflow.nodes[0]?.label).toBe('木盒分镜');
});
it('compares optional absent and undefined node fields consistently after JSON persistence', () => {
  const baseline = { ...node, modelId: undefined }, prepared = prepareWorkflowAssistant({ project, baseline, instruction: '修改名称', model: first, models: [first], nodeId: 'assistant' });
  const context = JSON.parse(JSON.stringify(prepared.context));
  const proposal = parseWorkflowAssistantResult(JSON.stringify({ summary: '简化名称', patch: { label: '新名称' } }), context);
  expect(applyWorkflowProposal(project, baseline, proposal).label).toBe('新名称');
});
it('classifies frozen failures and never permits a new run for uncertain, active, queued-owned or trial tasks', () => {
  expect(classifyModelFailure({ unknownSubmission: true, error: 'HTTP 401' })).toBe('unknown-submission');
  expect(classifyModelFailure({ error: 'HTTP 403' })).toBe('credentials');
  expect(classifyModelFailure({ error: 'HTTP 429' })).toBe('rate-limit');
  expect(classifyModelFailure({ error: 'HTTP 503' })).toBe('service');
  expect(classifyModelFailure({ error: 'HTTP 422' })).toBe('configuration');
  for (const failure of [{ unknownSubmission: true }, { trial: true }, { runStatus: 'waiting_external' }]) expect(modelAlternatives(node, [first, second], failure).canCreateRun).toBe(false);
  expect(modelAlternatives(node, [first, second], { error: 'HTTP 429', runStatus: 'failed' }).canCreateRun).toBe(true);
});
it('offers only enabled compatible connections, shows configured prices and prioritizes another service after service failures', () => {
  const same = model('same', { baseUrl: first.baseUrl }), disabled = model('disabled', { enabled: false });
  const image = model('image', { connectionType: 'image', capabilities: ['image'] });
  const result = modelAlternatives(node, [first, same, second, disabled, image], { error: 'HTTP 401' });
  expect(result.alternatives.map(item => item.model.id)).toEqual(['second', 'same']);
  expect(result.alternatives[0]?.price).toContain('¥1'); expect(result.alternatives[1]?.reasons).toContain('与原模型共用服务地址');
  expect(modelAlternatives(node, [first, model('proxy', { baseUrl: 'https://first.example/another-provider/v1' })], { error: 'HTTP 429' }).alternatives[0]?.sameService).toBe(false);
  expect(modelPriceDescription({}, 'image')).toBe('价格未配置');
  expect(modelPriceDescription({ pricing: { currency: 'USD', perImage: 0 } }, 'image')).toContain('$0/张');
  expect(modelAlternatives({ ...node, kind: 'animation', config: { operation: 'prepare-edit' } }, [first, image]).alternatives).toEqual([]);
});
