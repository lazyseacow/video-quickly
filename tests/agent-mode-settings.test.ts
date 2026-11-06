import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, productionSettingsSchema, workflowSchema } from '@video-quickly/contracts';
import { applyStageConfigurationDraft, updateProductionConfigurationDraft } from '../apps/desktop/src/lib/stage-configuration-draft';

it('opens historical production settings in workflow mode and preserves an explicit Agent choice', () => {
  const historical = { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' };
  expect(productionSettingsSchema.parse(historical).executionMode).toBe('workflow');
  expect(productionSettingsSchema.parse(historical)).toMatchObject({ agentSkillIds: [], agentMcpServerIds: [] });
  const configured = workflowSchema.parse({ ...createNativeVideoWorkflow(), production: { ...historical, executionMode: 'agent' } });
  expect(workflowSchema.parse(JSON.parse(JSON.stringify(configured))).production.executionMode).toBe('agent');
});

it('applies a saved Agent setting through the existing configuration draft without changing task selection', () => {
  const workflow = createNativeVideoWorkflow();
  const project = { brief: '演示视频', style: '', profile: DEFAULT_VIDEO_PROFILE };
  const draft = updateProductionConfigurationDraft('project', undefined, workflow, workflow.nodes, { ...workflow.production, executionMode: 'agent', agentSkillIds: ['skill-a', 'skill-b'], agentMcpServerIds: ['tool-a', 'tool-b'] }, project, project);
  const applied = applyStageConfigurationDraft(workflow, draft);
  expect(applied.conflicts).toEqual([]);
  expect(applied.workflow.production.executionMode).toBe('agent');
  expect(applied.workflow.production.agentSkillIds).toEqual(['skill-a', 'skill-b']);
  expect(applied.workflow.production.agentMcpServerIds).toEqual(['tool-a', 'tool-b']);
  expect(applied.workflow.nodes).toEqual(workflow.nodes);
  expect(applied.workflow.edges).toEqual(workflow.edges);
});

it('retains independent Skill and MCP selection when the other class uses automatic discovery', () => {
  expect(productionSettingsSchema.parse({ mode: 'native-video', executionMode: 'agent', agentSkillIds: ['skill-a', 'skill-b'] })).toMatchObject({ agentSkillIds: ['skill-a', 'skill-b'], agentMcpServerIds: [] });
  expect(productionSettingsSchema.parse({ mode: 'native-video', executionMode: 'agent', agentMcpServerIds: ['tool-a', 'tool-b'] })).toMatchObject({ agentSkillIds: [], agentMcpServerIds: ['tool-a', 'tool-b'] });
});
