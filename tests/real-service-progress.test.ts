import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, runSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src/index';
import { committedPhaseRun, resumePhaseRun } from '../scripts/real-service-progress';

const resources: Array<{ directory: string; runtime: ReturnType<typeof createRuntime> }> = [];
afterEach(async () => { for (const { runtime, directory } of resources.splice(0)) { await runtime.close(); await rm(directory, { recursive: true, force: true }); } });
async function fixture(options: Partial<RuntimeOptions> = {}, external = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-service-progress-'));
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: join(directory, 'not-used'), ...options }); const resource = { directory, runtime }; resources.push(resource);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '隔离的真实服务恢复逻辑回归' }));
  const model = external ? await runtime.dispatch('model.save', { model: { id: 'configured', name: '隔离网络边界', provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'configured', capabilities: ['text'] } }) as { id: string } : undefined;
  const saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { id: 'progress', name: '恢复检查', version: 1, nodes: [{ id: 'brief', kind: external ? 'style' : 'brief', label: '已经保存的实际活动', modelId: model?.id }], edges: [] } } }));
  return { runtime, project: saved, resource };
}

it('recovers a committed run after a lost start response without creating another run', async () => {
  const { runtime, project } = await fixture();
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'brief' })); await runtime.waitForIdle();
  expect(await committedPhaseRun(runtime.dispatch, project.id, 'brief', 'brief', project.revision)).toBe(run.id);
  await resumePhaseRun(runtime.dispatch, run.id);
  const history = await runtime.dispatch('run.list', { projectId: project.id }) as { items: unknown[] };
  expect(history.items).toHaveLength(1);
});

it('refuses ambiguous matching runs instead of creating or arbitrarily choosing one', async () => {
  const { runtime, project } = await fixture();
  await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'brief' }); await runtime.waitForIdle();
  await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'brief' }); await runtime.waitForIdle();
  await expect(committedPhaseRun(runtime.dispatch, project.id, 'brief', 'brief', project.revision)).rejects.toThrow('多个');
});

it('keeps an unknown external submission blocked across restart without calling the provider', async () => {
  let calls = 0;
  const provider = async () => { calls++; return '不应产生的重复结果'; };
  const { runtime, project, resource } = await fixture({ provider, failpoint(point) { if (point === 'after-dispatch') throw new SimulatedProcessExit(); } }, true);
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'brief' })); await runtime.waitForIdle(); await runtime.close();
  const restored = createRuntime({ dataDirectory: resource.directory, seed: false, ffmpegPath: join(resource.directory, 'not-used'), provider }); resource.runtime = restored;
  await expect(resumePhaseRun(restored.dispatch, run.id)).rejects.toThrow('未自动再次 POST');
  expect(calls).toBe(0);
});
