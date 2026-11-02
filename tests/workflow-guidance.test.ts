import { expect, it } from 'vitest';
import { modelSchema, workflowNodeSchema, type ModelProfile } from '@video-quickly/contracts';
import { matchingStepModels, stepGuidance, stepModelLabel, stepModelPlaceholder } from '../apps/desktop/src/lib/workflow-guidance';

function model(id: string, capabilities: ModelProfile['capabilities'], provider: ModelProfile['provider'] = 'openai-compatible') {
  return modelSchema.parse({ id, name: id, provider, model: id, capabilities, baseUrl: 'http://localhost/v1', createdAt: '', updatedAt: '' });
}
const models = [model('text', ['text']), model('agent', ['text', 'tools']), model('image', ['image'], 'seedream'), model('video', ['video'], 'seedance'), model('speech', ['tts'], 'qwen-tts'), model('asr', ['asr']), { ...model('disabled', ['text']), enabled: false }];

it('offers enabled models that match the actual generation role of each workflow step', () => {
  for (const [kind, expected] of [['script', ['text', 'agent']], ['agent', ['agent']], ['assets', ['image']], ['animation', ['video']], ['voice', ['speech']], ['review', []], ['export', []]] as const) {
    const node = workflowNodeSchema.parse({ id: kind, kind, label: kind });
    expect(matchingStepModels(node, models).map(value => value.id)).toEqual(expected);
  }
});

it('distinguishes transcription from speech synthesis and describes the expected result', () => {
  const node = workflowNodeSchema.parse({ id: 'transcribe', kind: 'voice', label: '识别字幕', config: { operation: 'transcribe' } });
  expect(matchingStepModels(node, models).map(value => value.id)).toEqual(['asr']);
  expect(stepGuidance(node).result).toContain('字幕');
  expect(stepGuidance(node).requiresModel).toBe(true);
  expect(stepGuidance({ kind: 'agent', config: {} }).requiresModel).toBe(true);
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
