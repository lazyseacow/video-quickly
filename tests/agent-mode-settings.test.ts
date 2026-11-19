import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, productionSettingsSchema, workflowSchema } from '@video-quickly/contracts';
import { applyStageConfigurationDraft, updateProductionConfigurationDraft } from '../src/renderer/lib/stage-configuration-draft';

it('reads historical project settings without retaining a production mode', () => {
  const historical = { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' };
  expect(productionSettingsSchema.parse(historical)).toMatchObject({ agentSkillIds: [], agentMcpServerIds: [] });
  for (const executionMode of ['workflow', 'agent']) {
    const production = { ...historical, executionMode, agentSkillIds: ['method'], agentMcpServerIds: ['tool'] };
    const configured = workflowSchema.parse({ ...createNativeVideoWorkflow(), production });
    expect(configured.production).not.toHaveProperty('executionMode');
    expect(configured.production).toMatchObject({ agentSkillIds: ['method'], agentMcpServerIds: ['tool'] });
  }
});

it('applies a saved Agent setting through the existing configuration draft without changing task selection', () => {
  const workflow = createNativeVideoWorkflow();
  const project = { brief: '演示视频', style: '', profile: DEFAULT_VIDEO_PROFILE };
  const draft = updateProductionConfigurationDraft('project', undefined, workflow, workflow.nodes, { ...workflow.production, agentSkillIds: ['skill-a', 'skill-b'], agentMcpServerIds: ['tool-a', 'tool-b'] }, project, project);
  const applied = applyStageConfigurationDraft(workflow, draft);
  expect(applied.conflicts).toEqual([]);
  expect(applied.workflow.production.agentSkillIds).toEqual(['skill-a', 'skill-b']);
  expect(applied.workflow.production.agentMcpServerIds).toEqual(['tool-a', 'tool-b']);
  expect(applied.workflow.nodes).toEqual(workflow.nodes);
  expect(applied.workflow.edges).toEqual(workflow.edges);
});

it('retains historical Skill and MCP fields independently', () => {
  expect(productionSettingsSchema.parse({ mode: 'native-video', agentSkillIds: ['skill-a', 'skill-b'] })).toMatchObject({ agentSkillIds: ['skill-a', 'skill-b'], agentMcpServerIds: [] });
  expect(productionSettingsSchema.parse({ mode: 'native-video', agentMcpServerIds: ['tool-a', 'tool-b'] })).toMatchObject({ agentSkillIds: [], agentMcpServerIds: ['tool-a', 'tool-b'] });
});

it('retains the historical inheritance flag for stored projects and snapshots', () => {
  for (const agentInheritsPlanningSkills of [true, false, undefined]) {
    expect(productionSettingsSchema.parse({ mode: 'native-video', agentInheritsPlanningSkills }).agentInheritsPlanningSkills).toBe(agentInheritsPlanningSkills);
  }
});
