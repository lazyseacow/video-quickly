import { expect, it } from 'vitest';
import { createHistoryWorkflow, createVideoWorkflow, resolveWorkflowStages } from '@video-quickly/contracts';
import { legacyHistoryWorkflow } from './fixtures/legacy-workflow';
import { resolveWorkbenchStages } from '../apps/desktop/src/lib/workbench-stages';

it('presents the saved legacy tasks in the four video stages without modifying the workflow', () => {
  const workflow = legacyHistoryWorkflow(), before = structuredClone(workflow);
  const stages = resolveWorkbenchStages(workflow);
  expect(stages?.map(stage => [stage.label, stage.nodeIds])).toEqual([
    ['策划与分镜', ['brief', 'research', 'style', 'script']],
    ['素材与配音', ['assets', 'voice']],
    ['剪辑与动画', ['animation']],
    ['审阅与导出', ['review', 'export']],
  ]);
  expect(workflow).toEqual(before);
});

it('retains explicit stage definitions and leaves ungrouped custom workflows alone', () => {
  const workflow = createVideoWorkflow();
  expect(resolveWorkbenchStages(workflow)).toEqual(resolveWorkflowStages(workflow));
  expect(resolveWorkbenchStages({ ...createHistoryWorkflow(), id: 'custom-workflow', stages: undefined })).toBeUndefined();
});
