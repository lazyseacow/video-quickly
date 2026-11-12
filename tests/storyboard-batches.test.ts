import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runInspectionSchema, runSchema, runStepPayloadSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../src/packages/runtime/src';
import { DocumentStore, openDatabase } from '../src/packages/runtime/src/database';
import { TextRequestRejectedError } from '../src/packages/runtime/src/providers';
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
const generatedEntities = [{ key: 'river', kind: 'scene', name: '河岸', description: '清晨的蓝色河岸' }];
const generated = JSON.stringify({ shots: generatedShots, entities: generatedEntities });

async function fixture(provider: NonNullable<RuntimeOptions['provider']>, { failpoint, responses = false }: { failpoint?: RuntimeOptions['failpoint']; responses?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-storyboard-batches-')); directories.push(directory);
  const options = { dataDirectory: directory, seed: false, provider };
  let runtime = createRuntime({ ...options, failpoint }); runtimes.add(runtime);
  const protocol = responses ? { provider: 'openai-compatible', textProtocol: 'responses', capabilities: ['text', 'structured-output'] } : { provider: 'ollama', capabilities: ['text'] };
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { ...protocol, name: '本地分镜夹具', baseUrl: 'http://127.0.0.1:1', connectionType: 'text', model: 'fixture' } }));
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
    directory, run, project, get runtime() { return runtime; },
    inspect: async () => runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id })),
    output: async () => runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId: run.id, nodeId: 'script', kind: 'output' })),
    current: async () => projectSchema.parse((await runtime.dispatch('project.get', { projectId: project.id }) as { project: unknown }).project),
    async reopen() { await runtime.close(); runtimes.delete(runtime); runtime = createRuntime(options); runtimes.add(runtime); },
  };
}

it('retains validated shots and the rate limit deadline across a restart, then reissues only the rejected batch', async () => {
  const calls: string[] = [];
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const source = await fixture(async ({ prompt, operationId }) => {
    calls.push(operationId.slice(operationId.indexOf(':storyboard:') + ':storyboard:'.length));
    expect(prompt).toContain('新生成或改写的视频镜头至少 4 秒');
    expect(prompt).toContain(operationId.includes(':outline:') ? '大纲按此下限安排全片节奏' : 'durationUs 填写不小于 4000000');
    if (operationId.endsWith(':2:response:1')) throw new TextRequestRejectedError(429, false, { kind: 'rate', retryAt });
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
  const retry = () => source.runtime.dispatch('run.step.retry', { runId: source.run.id, nodeId: 'script' });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.parse(retryAt) - 1);
    await expect(retry()).rejects.toThrow('请在');
    expect(calls).toHaveLength(3);
    expect((await source.inspect()).run.stepRetry).toBeUndefined();
    vi.setSystemTime(new Date(retryAt));
    await retry(); await source.runtime.waitForIdle();
  } finally { vi.useRealTimers(); }
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

it('revalidates a saved batch with an empty role whitelist and generates only the pending batch', async () => {
  const calls: string[] = [];
  const script = {
    shots: generatedShots.map(shot => ({ ...shot, visualPrompt: '王林沿河岸前行', characterKeys: ['char-wanglin'], entityKeys: ['river', 'wanglin'] })),
    entities: [...generatedEntities, { key: 'wanglin', kind: 'character', name: '王林', description: '粗布短褐' }],
  };
  const invalidScript = { ...script, shots: script.shots.map((shot, index) => index === 5 ? { ...shot, entityKeys: ['missing-entity'] } : shot) };
  let savedText = '';
  const source = await fixture(async ({ prompt, operationId }) => {
    calls.push(operationId.split(':storyboard:')[1]);
    if (!operationId.includes(':outline:')) expect(prompt).toContain('每个镜头的 characterKeys 都填 []');
    const response = storyboardFixtureResponse(prompt, JSON.stringify(script));
    if (!operationId.endsWith(':2:response:1')) return response;
    savedText = response;
    return storyboardFixtureResponse(prompt, JSON.stringify(invalidScript));
  });
  expect((await source.output()).modelResponse?.issues).toEqual([{ path: 'shots[0].entityKeys[0]', message: '分镜引用的创作设定不存在。' }]);
  const originalDraft = (await source.output()).partialStoryboard;
  expect(originalDraft?.shots).toHaveLength(5);
  expect(originalDraft?.shots[1].visualPrompt).toBe('王林沿河岸前行');

  // Seed the receipt left by the previous validator, retaining its original input hash and attempt.
  const receiptId = `${source.run.id}:script:storyboard:2:1`;
  const database = openDatabase(source.directory);
  const store = new DocumentStore(database);
  const receipt = store.get<Record<string, unknown>>('model-response', receiptId);
  try {
    expect(receipt).toMatchObject({ status: 'received', attempt: 1 });
    store.put('model-response', receiptId, { ...receipt, response: { text: savedText }, issues: [
      { path: 'shots[0].characterKeys[0]', message: '分镜引用的角色键不在本次角色白名单中。' },
    ] });
  } finally { database.close(); }

  await source.reopen();
  await source.runtime.dispatch('run.step.retry', { runId: source.run.id, nodeId: 'script' }); await source.runtime.waitForIdle();
  expect(calls).toEqual(['outline:response:1', '1:response:1', '2:response:1', '3:response:1']);
  expect((await source.inspect()).steps.map(step => step.status)).toEqual(['succeeded', 'pending']);
  const output = (await source.output()).value as { shots: unknown; outline: string };
  const shots = projectSchema.shape.shots.parse(output.shots);
  expect(output.outline).toBe(originalDraft?.outline);
  expect(runStepPayloadSchema.shape.partialStoryboard.unwrap().shape.shots.parse(shots.slice(0, 5))).toEqual(originalDraft?.shots);
  expect(shots).toHaveLength(12);
  expect(shots[1]).toMatchObject({ characterIds: [], visualPrompt: '王林沿河岸前行', creativeEntityKeys: ['river', 'wanglin'] });
  expect(shots[5]).toMatchObject({ characterIds: [], visualPrompt: '王林沿河岸前行', creativeEntityKeys: ['river', 'wanglin'] });
});

it('reuses the response from an automatic batch retry after interruption before commit', async () => {
  const calls: { part: string; promptFormat: boolean }[] = [];
  const source = await fixture(async ({ prompt, operationId, promptOutputFormat }) => {
    const part = operationId.split(':storyboard:')[1];
    calls.push({ part, promptFormat: Boolean(promptOutputFormat) });
    if (part === '2:response:1') return { text: '', incomplete: true, incompleteReason: 'unknown' };
    return storyboardFixtureResponse(prompt, generated);
  }, {
    responses: true,
    failpoint(point, id) {
      if (point === 'after-result' && id === 'script:storyboard:2') throw new SimulatedProcessExit();
    },
  });
  expect((await source.output()).partialStoryboard?.shots).toHaveLength(5);
  await source.reopen();
  await source.runtime.dispatch('run.resume', { runId: source.run.id }); await source.runtime.waitForIdle();
  expect((await source.inspect()).run.status).toBe('succeeded');
  expect(calls).toEqual([
    { part: 'outline:response:1', promptFormat: false },
    { part: '1:response:1', promptFormat: false },
    { part: '2:response:1', promptFormat: false },
    { part: '2:response:2', promptFormat: true },
    { part: '3:response:1', promptFormat: true },
  ]);
  expect((await source.current()).shots).toHaveLength(12);
});

it.each([
  { outcome: 'empty', unknown: false },
  { outcome: 'disconnected', unknown: true },
])('stops after one automatic outline retry when the next response is $outcome', async ({ unknown }) => {
  const calls: string[] = [];
  const source = await fixture(async ({ operationId, promptOutputFormat }) => {
    calls.push(operationId);
    if (promptOutputFormat && unknown) throw new Error('fixture disconnected during retry');
    return { text: '', incomplete: true, incompleteReason: 'unknown' };
  }, { responses: true });
  expect((await source.inspect()).steps[0]).toMatchObject({
    outputAvailable: false, unknownSubmission: unknown, retry: { allowed: !unknown }, progress: { storyboard: { kind: 'outline' } },
  });
  expect(calls.map(call => call.split(':storyboard:')[1])).toEqual(['outline:response:1', 'outline:response:2']);
  await source.reopen();
  await source.runtime.dispatch('run.resume', { runId: source.run.id }); await source.runtime.waitForIdle();
  expect(calls).toHaveLength(2);
  expect((await source.inspect()).steps[0]).toMatchObject({ outputAvailable: false, unknownSubmission: unknown });
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
