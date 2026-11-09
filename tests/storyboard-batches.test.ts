import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSchema, projectSchema, runInspectionSchema, runSchema, runStepPayloadSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';
import { TextRequestRejectedError } from '../packages/runtime/src/providers';
import { storyboardFixtureResponse } from './fixtures/planning-response';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const generatedShots = Array.from({ length: 12 }, (_, index) => ({
  title: `镜头 ${index + 1}`, narration: `旁白 ${index + 1}`, visualPrompt: '蓝色水彩', durationUs: 1_000_000,
  entityKeys: ['river'],
}));
const generated = JSON.stringify({ shots: generatedShots, entities: [{ key: 'river', kind: 'scene', name: '河岸', description: '清晨的蓝色河岸' }] });

async function fixture(provider: NonNullable<RuntimeOptions['provider']>, failpoint?: RuntimeOptions['failpoint']) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-storyboard-batches-')); directories.push(directory);
  const options = { dataDirectory: directory, seed: false, provider };
  let runtime = createRuntime({ ...options, failpoint }); runtimes.add(runtime);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本地分镜夹具', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', connectionType: 'text', capabilities: ['text'], model: 'fixture' } }));
  const base = projectSchema.parse(await runtime.dispatch('project.create', { title: '十二镜头分镜', brief: '无需联网，写十二个镜头。' }));
  const script = base.workflow.nodes.find(node => node.id === 'script')!;
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: base.id, patch: {
    shots: [{ id: 'shot-6', title: '锁定开场', narration: '保留原旁白', visualPrompt: '保留原画面', locked: true, durationUs: 2_000_000 }],
    workflow: {
      ...base.workflow, production: { ...base.workflow.production, textModelId: model.id }, stages: undefined,
      nodes: [script, workflowNodeSchema.parse({ id: 'tail', label: '后续任务', kind: 'join' })],
      edges: [{ id: 'script-tail', source: 'script', target: 'tail' }],
    },
  } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id }));
  await runtime.waitForIdle();
  return {
    run, project, get runtime() { return runtime; },
    inspect: async () => runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id })),
    output: async () => runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId: run.id, nodeId: 'script', kind: 'output' })),
    current: async () => projectSchema.parse((await runtime.dispatch('project.get', { projectId: project.id }) as { project: unknown }).project),
    async reopen() { await runtime.close(); runtimes.delete(runtime); runtime = createRuntime(options); runtimes.add(runtime); },
  };
}

it('retains validated shots across a restart and reissues only the rejected batch', async () => {
  const calls: string[] = [];
  let failSecond = true;
  const source = await fixture(async ({ prompt, operationId }) => {
    calls.push(operationId.slice(operationId.indexOf(':storyboard:') + ':storyboard:'.length));
    if (operationId.endsWith(':2:response:1') && failSecond) throw new TextRequestRejectedError(400);
    return storyboardFixtureResponse(prompt, generated);
  });
  expect(calls).toEqual(['outline:response:1', '1:response:1', '2:response:1']);
  const stopped = await source.inspect();
  expect(stopped.recovery.resume).toBe(false);
  expect(stopped.run.completedNodeIds).not.toContain('script');
  expect(stopped.steps[0]).toMatchObject({ outputAvailable: false, unknownSubmission: false, retry: { allowed: true },
    progress: { completed: 5, total: 12, storyboard: { kind: 'batch', index: 2, batches: 3 } } });
  const draft = (await source.output()).partialStoryboard;
  expect(draft?.shots.map(shot => shot.title)).toEqual(['锁定开场', ...generatedShots.slice(1, 5).map(shot => shot.title)]);
  expect(await source.current()).toEqual(source.project);
  await source.reopen();
  expect((await source.output()).partialStoryboard).toEqual(draft);
  failSecond = false;
  await source.runtime.dispatch('run.step.retry', { runId: source.run.id, nodeId: 'script' }); await source.runtime.waitForIdle();
  expect(calls).toEqual(['outline:response:1', '1:response:1', '2:response:1', '2:response:2', '3:response:1']);
  const completed = await source.inspect();
  expect(completed.run).toMatchObject({ id: source.run.id, stepRetry: { nodeId: 'script', status: 'completed' } });
  expect(completed.steps.map(step => step.status)).toEqual(['succeeded', 'pending']);
  const output = await source.output();
  expect(output.available).toBe(true);
  expect(output.value).toMatchObject({ outline: draft?.outline, shots: [source.project.shots[0], ...generatedShots.slice(1).map(shot => ({ title: shot.title }))] });
  const fullShots = projectSchema.shape.shots.parse((output.value as { shots: unknown }).shots);
  const merged = JSON.parse((output.value as { text: string }).text);
  expect(merged.shots.map((shot: { title: string }) => shot.title)).toEqual(fullShots.map(shot => shot.title));
  expect(new Set(fullShots.map(shot => shot.id)).size).toBe(12);
  expect(fullShots.slice(0, 5).map(shot => shot.id)).toEqual(draft?.shots.map(shot => shot.id));
  expect(output.partialStoryboard).toBeUndefined();
});

it('reuses a received batch after interruption between validation and durable commit', async () => {
  const calls: string[] = [];
  const source = await fixture(async ({ prompt, operationId }) => {
    calls.push(operationId);
    return storyboardFixtureResponse(prompt, generated);
  }, (point, id) => {
    if (point === 'after-result' && id === 'script:storyboard:2') throw new SimulatedProcessExit();
  });
  expect((await source.output()).partialStoryboard?.shots).toHaveLength(5);
  await source.reopen();
  await source.runtime.dispatch('run.resume', { runId: source.run.id }); await source.runtime.waitForIdle();
  expect((await source.inspect()).run.status).toBe('succeeded');
  expect(calls.map(call => call.split(':storyboard:')[1])).toEqual(['outline:response:1', '1:response:1', '2:response:1', '3:response:1']);
  expect((await source.current()).shots).toHaveLength(12);
});

it('blocks resubmission of an unconfirmed batch while preserving the preceding shots', async () => {
  const calls: string[] = [];
  const source = await fixture(async ({ prompt, operationId }) => {
    calls.push(operationId);
    if (operationId.includes(':storyboard:2:')) throw new Error('fixture disconnected');
    return storyboardFixtureResponse(prompt, generated);
  });
  expect((await source.inspect()).steps[0]).toMatchObject({ unknownSubmission: true, retry: { allowed: false } });
  expect((await source.output()).partialStoryboard?.shots).toHaveLength(5);
  await expect(source.runtime.dispatch('run.step.retry', { runId: source.run.id, nodeId: 'script' })).rejects.toThrow('存在结果未确认');
  await source.runtime.dispatch('run.resume', { runId: source.run.id }); await source.runtime.waitForIdle();
  expect(calls).toHaveLength(3);
  expect((await source.output()).partialStoryboard?.shots).toHaveLength(5);
});
