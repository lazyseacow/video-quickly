import { expect, it } from 'vitest';
import { modelSchema, workflowNodeSchema, type ModelProfile } from '@video-quickly/contracts';
import { matchingStepModels, stepGuidance, stepModelLabel, stepModelPlaceholder } from '../src/renderer/lib/workflow-guidance';

function model(id: string, capabilities: ModelProfile['capabilities'], provider: ModelProfile['provider'] = 'openai-compatible') {
  return modelSchema.parse({ id, name: id, provider, parameters: {  }, model: id, connectionType: ((capabilities) as readonly string[]).includes('text') ? 'text' : ((capabilities) as readonly string[]).includes('video') ? 'video' : 'image', capabilities, baseUrl: 'http://localhost/v1', createdAt: '', updatedAt: '' });
}
const models = [model('text', ['text']), model('agent', ['text', 'tools']), model('image', ['image'], 'seedream'), model('video', ['video'], 'seedance'), { ...model('disabled', ['text']), enabled: false }];

it('offers enabled models that match the actual generation role of each workflow step', () => {
  for (const [kind, expected] of [['script', ['text', 'agent']], ['agent', ['agent']], ['assets', ['image']], ['animation', ['video']], ['review', []], ['export', []]] as const) {
    const node = workflowNodeSchema.parse({ id: kind, kind, label: kind });
    expect(matchingStepModels(node, models).map(value => value.id)).toEqual(expected);
  }
});



it('keeps local production and unavailable saved model selections explicit', () => {
  const node = workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '分镜' });
  expect(stepModelLabel(node, models)).toBe('已有分镜');
  expect(stepModelLabel({ ...node, modelId: 'text' }, models)).toBe('text');
  expect(stepModelLabel({ ...node, modelId: 'disabled' }, models)).toBe('模型已停用');
  expect(stepModelLabel({ ...node, modelId: 'removed' }, models)).toBe('模型已移除');
  expect(stepModelLabel({ ...node, modelId: 'image' }, models)).toBe('模型能力不匹配');
});

it('shows no available model for empty, disabled or incompatible model lists', () => {
  const node = workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '创意简报' });
  for (const candidates of [[], [models[2]], [models.at(-1)!]]) {
    expect(stepModelPlaceholder(node, matchingStepModels(node, candidates))).toBe('无可用模型');
  }
  expect(stepModelPlaceholder(node, matchingStepModels(node, models))).toBe('项目简报（不调用模型）');
});
