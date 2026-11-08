import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, isModelGenerationNode, resolveWorkflowStages } from '@video-quickly/contracts';
import { resolveWorkbenchStages } from '../apps/desktop/src/lib/workbench-stages';

it('retains explicit stage definitions and leaves ungrouped custom workflows alone', () => {
  const workflow = { ...createNativeVideoWorkflow(), id: 'custom-workflow' };
  expect(resolveWorkbenchStages(workflow)).toEqual(resolveWorkflowStages(workflow));
  expect(resolveWorkbenchStages({ ...workflow, stages: undefined })).toBeUndefined();
});

it('keeps four native stages for every reference mode and incomplete stage metadata', () => {
  const workflow = createNativeVideoWorkflow();
  for (const referenceMode of ['none', 'generate', 'existing'] as const) {
    const stages = resolveWorkbenchStages({ ...workflow, stages: undefined, production: { ...workflow.production, referenceMode } });
    expect(stages?.map(stage => stage.label)).toEqual(['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出']);
    expect(stages?.map(stage => stage.nodeIds)).toEqual([['brief', 'style', 'script'], ['assets', 'video'], ['animation'], ['export']]);
  }
  expect(isModelGenerationNode({ ...workflow.nodes.find(node => node.id === 'animation')!, modelId: 'old-model' })).toBe(false);
  expect(isModelGenerationNode({ ...workflow.nodes.find(node => node.id === 'export')!, modelId: 'old-model' })).toBe(false);
});
