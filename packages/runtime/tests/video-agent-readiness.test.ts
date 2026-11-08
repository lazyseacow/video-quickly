import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectReadinessSchema, projectSchema } from '@video-quickly/contracts';
import { createRuntime } from '../src/index.js';

const fixtures: Array<{ directory: string; runtime: ReturnType<typeof createRuntime> }> = [];
afterEach(async () => {
  for (const { directory, runtime } of fixtures.splice(0)) {
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});

it.each(['openai-compatible', 'ollama'] as const)('checks the unified workflow with %s and keeps a scoped editing step local', async providerType => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-agent-readiness-'));
  const provider = vi.fn(async () => 'must-not-be-called');
  const runtime = createRuntime({ dataDirectory: directory, seed: false, provider }); fixtures.push({ directory, runtime });
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '自主制作前检查' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: 'Agent fixture', provider: providerType, baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'],
  } }));
  await runtime.dispatch('tool.register', { server: { name: '剪辑工具', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true } });
  const configured = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision,
    patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, textModelId: model.id, agentSkillIds: ['unavailable'] } } },
  }));
  const noExecutor = projectReadinessSchema.parse(await runtime.dispatch('project.readiness', { projectId: configured.id }));
  expect(noExecutor.ready).toBe(false);
  expect(noExecutor.issues).toContainEqual(expect.objectContaining({ category: 'environment', fix: 'runtime' }));
  expect(noExecutor.issues).toContainEqual(expect.objectContaining({ category: 'model', nodeId: 'video' }));
  expect(noExecutor.stepCount).toBe(7);
  expect(noExecutor.issues.some(issue => issue.category === 'skill' && issue.nodeId === 'animation')).toBe(providerType === 'openai-compatible');
  const scoped = projectReadinessSchema.parse(await runtime.dispatch('project.readiness', { projectId: configured.id, selection: { nodeId: 'animation', mode: 'node' } }));
  expect(scoped).toMatchObject({ ready: true, stepCount: 1, modelCount: 0, issues: [] });
  expect(provider).not.toHaveBeenCalled();
});
