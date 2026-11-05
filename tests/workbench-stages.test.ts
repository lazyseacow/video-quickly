import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, isModelGenerationNode, resolveProductionWorkflow, resolveWorkflowStages } from '@video-quickly/contracts';
import { resolveGenerationSteps, resolveWorkbenchStages } from '../apps/desktop/src/lib/workbench-stages';



it('retains explicit stage definitions and leaves ungrouped custom workflows alone', () => {
  const workflow = createNativeVideoWorkflow();
  expect(resolveWorkbenchStages(workflow)).toEqual(resolveWorkflowStages(workflow));
  expect(resolveWorkbenchStages({ ...createNativeVideoWorkflow(), id: 'custom-workflow', stages: undefined })).toBeUndefined();
});

it('shows the native model generation tasks and includes reference generation only when enabled', () => {
  const workflow = createNativeVideoWorkflow();
  expect(resolveGenerationSteps(workflow).map(step => step.label)).toEqual(['简报生成', '风格与角色生成', '分镜生成', '镜头视频生成']);
  const withImages = resolveProductionWorkflow({ ...workflow, production: { ...workflow.production, referenceMode: 'generate' } });
  expect(resolveGenerationSteps(withImages).map(step => step.nodeIds[0])).toEqual(['brief', 'style', 'script', 'assets', 'video']);
  expect(resolveGenerationSteps(resolveProductionWorkflow({ ...withImages, production: { ...withImages.production, referenceMode: 'existing' } })).map(step => step.nodeIds[0])).toEqual(['brief', 'style', 'script', 'video']);
  expect(isModelGenerationNode({ ...workflow.nodes.find(node => node.id === 'animation')!, modelId: 'old-model' })).toBe(false);
  expect(isModelGenerationNode({ ...workflow.nodes.find(node => node.id === 'export')!, modelId: 'old-model' })).toBe(false);
});
