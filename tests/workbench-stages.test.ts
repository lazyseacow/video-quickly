import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, resolveWorkflowStages } from '@video-quickly/contracts';
import { resolveWorkbenchStages } from '../apps/desktop/src/lib/workbench-stages';



it('retains explicit stage definitions and leaves ungrouped custom workflows alone', () => {
  const workflow = createNativeVideoWorkflow();
  expect(resolveWorkbenchStages(workflow)).toEqual(resolveWorkflowStages(workflow));
  expect(resolveWorkbenchStages({ ...createNativeVideoWorkflow(), id: 'custom-workflow', stages: undefined })).toBeUndefined();
});
