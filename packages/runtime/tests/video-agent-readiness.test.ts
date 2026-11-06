import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createRuntime } from '../src/index.js';
import { createProjectReadiness } from '../src/project-readiness.js';
import { videoAgentNode } from '../src/video-agent.js';

const fixtures: Array<{ directory: string; runtime: ReturnType<typeof createRuntime> }> = [];
afterEach(async () => {
  for (const { directory, runtime } of fixtures.splice(0)) {
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});

it('checks the export engine before an autonomous Agent can spend model usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-agent-readiness-'));
  const provider = vi.fn(async () => 'must-not-be-called');
  const runtime = createRuntime({ dataDirectory: directory, seed: false, provider }); fixtures.push({ directory, runtime });
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '自主制作前检查' }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: 'Agent fixture', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', connectionType: 'text', capabilities: ['text', 'tools'],
  } }));
  const configured = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision,
    patch: { workflow: { ...project.workflow, production: { ...project.workflow.production, executionMode: 'agent', textModelId: model.id } } },
  }));
  const noExecutor = await runtime.dispatch('project.readiness', { projectId: configured.id }) as { ready: boolean; issues: Array<{ category: string; fix: string }> };
  expect(noExecutor.ready).toBe(false);
  expect(noExecutor.issues).toContainEqual(expect.objectContaining({ category: 'environment', fix: 'runtime' }));
  const workspace = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  for (const ffmpegAvailable of [false, true]) {
    const readiness = createProjectReadiness({ system: { ...workspace.system, ffmpegAvailable }, directory,
      hasMediaExecutor: true, redactText: text => text,
      snapshot: () => ({ project: configured, nodes: [videoAgentNode(configured)], models: [model], assets: [], characters: [], skills: [] }),
    });
    const checked = await readiness.check(configured.id);
    expect(checked.ready).toBe(ffmpegAvailable);
    expect(checked.issues.some(issue => issue.category === 'environment')).toBe(!ffmpegAvailable);
    await readiness.close();
  }
  expect(provider).not.toHaveBeenCalled();
});
