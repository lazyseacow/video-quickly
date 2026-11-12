import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assetSchema, modelSchema, projectDetailSchema, projectSchema, runSchema, runStepPayloadSchema, shotCandidateSchema, type AssetRecord, type ProjectDocument, type ShotCandidate } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../src/packages/runtime/src';
import { DocumentStore, openDatabase } from '../src/packages/runtime/src/database';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(kind: 'image' | 'video' = 'image', extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-source-shot-')); directories.push(directory);
  let textCalls = 0;
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async () => ++textCalls === 1 ? '本次已完成的简报' : '本次已完成的风格');
  const executeActivity = vi.fn<NonNullable<RuntimeOptions['executeActivity']>>(async context => ({ assets: await Promise.all(context.project.shots.map(async shot => {
    const bytes = Buffer.from(`${context.runId}:${shot.id}`), path = join(directory, `${context.runId}-${shot.id}.fixture`); await writeFile(path, bytes);
    return assetSchema.parse({ id: `${context.runId}-${shot.id}`, projectId: context.project.id, shotId: shot.id, name: `${shot.id}.fixture`, kind, path, mimeType: `${kind}/fixture`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), durationUs: 1_000_000, version: 1, createdAt: '', provenance: 'controlled media boundary' });
  })) }));
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider, executeActivity, ...extra };
  const runtime = createRuntime(options); runtimes.push(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '保留制作上下文的单镜头生成' }));
  const text = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '原文本模型', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'text', connectionType: 'text', capabilities: ['text'] } }));
  const media = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '本次冻结媒体模型', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', model: 'media-original', connectionType: kind, capabilities: [kind] } }));
  const references: AssetRecord[] = [];
  if (kind === 'video') for (const index of [1, 2]) {
    const path = join(directory, `reference-${index}.png`);
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    references.push(assetSchema.parse(await runtime.dispatch('asset.import', { projectId: created.id, path, kind: 'image' })));
  }
  const prepared = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots: [1, 2].map(index => ({ id: `shot-${index}`, title: `原镜头 ${index}`, narration: `原旁白 ${index}`, visualPrompt: `原画面 ${index}`, durationUs: 1_000_000, ...(references[index - 1] ? { assetId: references[index - 1].id } : {}) })),
    workflow: { id: 'source-regeneration', name: 'source', version: 1, production: { mode: 'native-video', referenceMode: kind === 'video' ? 'existing' : 'none', subtitleMode: 'off', soundPrompt: '' }, nodes: [
      { id: 'brief', kind: 'brief', label: '简报', modelId: text.id }, { id: 'style', kind: 'style', label: '风格', modelId: text.id },
      { id: 'media', kind: kind === 'image' ? 'assets' : 'animation', label: '镜头素材', modelId: media.id, prompt: '本次冻结的媒体要求' }, { id: 'finish', kind: 'join', label: '完成' },
    ], edges: [{ id: 'a', source: 'brief', target: 'style' }, { id: 'b', source: 'style', target: 'media' }, { id: 'c', source: 'media', target: 'finish' }] },
  } }));
  const origin = runSchema.parse(await runtime.dispatch('run.start', { projectId: prepared.id })); await runtime.waitForIdle();
  expect(runSchema.parse(await runtime.dispatch('run.get', { runId: origin.id })).status).toBe('succeeded');
  expect(executeActivity).toHaveBeenCalledTimes(1);
  expect(await runtime.dispatch('node.result', { runId: origin.id, nodeId: 'media' })).toMatchObject({ assets: [{ shotId: 'shot-1' }, { shotId: 'shot-2' }] });
  executeActivity.mockClear();
  const current = async (target = runtime) => projectDetailSchema.parse(await target.dispatch('project.get', { projectId: prepared.id }));
  const project = (await current()).project!;
  const input = { projectId: project.id, shotId: 'shot-2', kind, revision: project.revision, source: { runId: origin.id, nodeId: 'media', requestId: randomUUID() } };
  return { runtime, directory, options, origin, project, media, references, provider, executeActivity, input, current };
}
async function candidate(runtime: ReturnType<typeof createRuntime>, runId: string) {
  const output = runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId, nodeId: 'regenerate', kind: 'output' }));
  if (!output.value || typeof output.value !== 'object' || Array.isArray(output.value) || typeof output.value.candidateId !== 'string') throw new Error('Missing candidate');
  return shotCandidateSchema.parse(await runtime.dispatch('shot.candidate.get', { projectId: runSchema.parse(await runtime.dispatch('run.get', { runId })).projectId, candidateId: output.value.candidateId }));
}

it.each(['image', 'video'] as const)('regenerates one %s using the origin input, model and upstream while preserving the original production', async kind => {
  const f = await fixture(kind), originBefore = await f.runtime.dispatch('run.get', { runId: f.origin.id });
  const originalOutput = await f.runtime.dispatch('node.result', { runId: f.origin.id, nodeId: 'media' });
  const database = openDatabase(f.directory);
  try {
    const store = new DocumentStore(database), sourceId = `${f.origin.id}:media`;
    const source = store.get<ProjectDocument>('node-project', sourceId)!;
    store.put('node-project', sourceId, { ...source, workflow: { ...source.workflow, execution: { maxConcurrentShots: 2, modelLimits: {} } } });
  } finally { database.close(); }
  const edited = projectSchema.parse(await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: {
    brief: '后来修改的简报', style: '后来修改的风格', shots: f.project.shots.map(shot => ({ ...shot, title: `后来修改的${shot.title}`, ...(kind === 'video' ? { assetId: f.references[0].id } : {}) })),
    workflow: { ...f.project.workflow, nodes: f.project.workflow.nodes.map(node => node.id === 'media' ? { ...node, prompt: '下次制作的新要求' } : node) },
  } }));
  await f.runtime.dispatch('model.save', { model: { ...f.media, name: '后来修改的模型', model: 'later-media' } });
  const run = runSchema.parse(await f.runtime.dispatch('shot.regenerate', { ...f.input, revision: edited.revision })); await f.runtime.waitForIdle();
  expect(run.parentRunId).toBe(f.origin.id); expect(run.regenerationSource?.shotId).toBe('shot-2');
  expect(f.provider).toHaveBeenCalledTimes(2); expect(f.executeActivity).toHaveBeenCalledTimes(1);
  const context = f.executeActivity.mock.calls[0][0];
  expect(context.project.shots.map(shot => shot.id)).toEqual(['shot-2']);
  expect(context.project.workflow).not.toHaveProperty('execution');
  expect(context.project).toMatchObject({ brief: '本次已完成的简报', style: '本次已完成的风格', shots: [{ title: '原镜头 2' }] });
  expect(context.node.prompt).toBe('本次冻结的媒体要求'); expect(context.model?.model).toBe('media-original');
  expect(context.promptUpstream).toMatchObject({ brief: { text: '本次已完成的简报' }, style: { text: '本次已完成的风格' } });
  if (kind === 'video') {
    expect(context.project.shots[0].assetId).toBe(f.references[1].id);
    expect(context.assets.map(asset => asset.id)).toEqual([f.references[1].id]);
  }
  expect(await f.runtime.dispatch('run.get', { runId: f.origin.id })).toEqual(originBefore);
  expect(await f.runtime.dispatch('node.result', { runId: f.origin.id, nodeId: 'media' })).toEqual(originalOutput);
  expect((await f.current()).latestRun?.id).toBe(f.origin.id); expect((await f.current()).project).toEqual(edited);
  const next = await candidate(f.runtime, run.id);
  const applied = projectSchema.parse(await f.runtime.dispatch('shot.candidate.apply', { projectId: edited.id, candidateId: next.id, revision: edited.revision }));
  expect(applied.shots[0]).toEqual(edited.shots[0]); expect(applied.shots[1].title).toBe(edited.shots[1].title);
  expect(applied.shots[1].assetId).toBe(kind === 'image' ? next.assetIds[0] : edited.shots[1].assetId);
  expect(kind === 'image' ? applied.shots[1].assetId : applied.shots[1].videoAssetId).toBe(next.assetIds[0]);
  expect(f.provider).toHaveBeenCalledTimes(2); expect(f.executeActivity).toHaveBeenCalledTimes(1);
});

it('returns the same durable run for a repeated request, and rejects changing its input', async () => {
  const f = await fixture();
  const results = await Promise.all([f.runtime.dispatch('shot.regenerate', f.input), f.runtime.dispatch('shot.regenerate', f.input)]); await f.runtime.waitForIdle();
  expect(results.map(result => runSchema.parse(result).id)[0]).toBe(runSchema.parse(results[1]).id); expect(f.executeActivity).toHaveBeenCalledTimes(1);
  await expect(f.runtime.dispatch('shot.regenerate', { ...f.input, instruction: 'another instruction' })).rejects.toThrow('标识');
});

it('keeps the original progress visible and exposes only the active shot regeneration as active work', async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  f.executeActivity.mockImplementationOnce(async context => { entered.resolve(); await release.promise; return { assets: [] }; });
  try {
    const run = runSchema.parse(await f.runtime.dispatch('shot.regenerate', f.input)); await entered.promise;
    const detail = await f.current(); expect(detail.latestRun?.id).toBe(f.origin.id); expect(detail.activeRun?.id).toBe(run.id);
    const repeated = runSchema.parse(await f.runtime.dispatch('shot.regenerate', { ...f.input, source: { ...f.input.source, requestId: randomUUID() } }));
    expect(repeated.id).toBe(run.id); expect(f.executeActivity).toHaveBeenCalledTimes(1);
    await f.runtime.dispatch('run.cancel', { runId: run.id });
  } finally { release.resolve(); await f.runtime.waitForIdle(); }
});

it('restores a committed sourced candidate after reopening without regenerating siblings or upstream', async () => {
  let armed = false, exited = false;
  const f = await fixture('image', { failpoint(point, activityId) { if (armed && !exited && point === 'after-commit' && activityId === 'regenerate') { exited = true; throw new SimulatedProcessExit(); } } });
  armed = true; const run = runSchema.parse(await f.runtime.dispatch('shot.regenerate', f.input)); await f.runtime.waitForIdle(); expect(exited).toBe(true); await f.runtime.close();
  const recovered = createRuntime({ ...f.options, failpoint: undefined }); runtimes.push(recovered);
  await recovered.dispatch('run.resume', { runId: run.id }); await recovered.waitForIdle();
  expect((await candidate(recovered, run.id)).shotId).toBe('shot-2'); expect(f.executeActivity).toHaveBeenCalledTimes(1); expect(f.provider).toHaveBeenCalledTimes(2);
  const page = await recovered.dispatch('shot.candidates', { projectId: f.project.id, shotId: 'shot-2', source: f.input.source }) as { items: ShotCandidate[] };
  expect(page.items).toHaveLength(1);
  const unrelated = await recovered.dispatch('shot.candidates', { projectId: f.project.id, shotId: 'shot-2', source: { ...f.input.source, nodeId: 'other' } }) as { items: ShotCandidate[] };
  expect(unrelated.items).toEqual([]);
});

it('requires resolving an unfinished sourced attempt before creating another paid generation', async () => {
  const f = await fixture(); f.executeActivity.mockRejectedValueOnce(new Error('ambiguous submit'));
  const run = runSchema.parse(await f.runtime.dispatch('shot.regenerate', f.input)); await f.runtime.waitForIdle();
  const next = runSchema.parse(await f.runtime.dispatch('shot.regenerate', { ...f.input, source: { ...f.input.source, requestId: randomUUID() } }));
  expect(next.id).toBe(run.id); expect(f.executeActivity).toHaveBeenCalledTimes(1);
  const page = await f.runtime.dispatch('shot.candidates', { projectId: f.project.id, shotId: 'shot-2', source: f.input.source }) as { activeRun: { id: string } };
  expect(page.activeRun.id).toBe(run.id);
});

it('retains the original production inputs when restarting a canceled sourced generation from history', async () => {
  const f = await fixture(); f.executeActivity.mockRejectedValueOnce(new Error('controlled interrupted generation'));
  const failed = runSchema.parse(await f.runtime.dispatch('shot.regenerate', f.input)); await f.runtime.waitForIdle();
  await f.runtime.dispatch('run.cancel', { runId: failed.id });
  const restarted = runSchema.parse(await f.runtime.dispatch('run.start', { projectId: f.project.id, parentRunId: failed.id })); await f.runtime.waitForIdle();
  expect(restarted.regenerationSource).toMatchObject({ runId: f.origin.id, nodeId: 'media', shotId: 'shot-2' });
  expect(f.executeActivity).toHaveBeenCalledTimes(2);
  expect(f.executeActivity.mock.calls[1][0].project.shots.map(shot => shot.id)).toEqual(['shot-2']);
  expect(f.executeActivity.mock.calls[1][0].project.brief).toBe('本次已完成的简报'); expect(f.provider).toHaveBeenCalledTimes(2);
});

it('rejects unrelated, unavailable and locked shots before starting generation', async () => {
  const f = await fixture();
  await expect(f.runtime.dispatch('shot.regenerate', { ...f.input, shotId: 'missing' })).rejects.toThrow();
  await expect(f.runtime.dispatch('shot.regenerate', { ...f.input, source: { ...f.input.source, nodeId: 'brief' } })).rejects.toThrow();
  const locked = projectSchema.parse(await f.runtime.dispatch('project.update', { projectId: f.project.id, revision: f.project.revision, patch: { shots: f.project.shots.map(shot => ({ ...shot, locked: true })) } }));
  await expect(f.runtime.dispatch('shot.regenerate', { ...f.input, revision: locked.revision })).rejects.toThrow('解锁');
  expect(f.executeActivity).not.toHaveBeenCalled(); expect(f.provider).toHaveBeenCalledTimes(2);
});

it('requires restoring a missing original reference instead of regenerating upstream or using a later reference', async () => {
  const f = await fixture('video'); await unlink(f.references[1].path);
  await expect(f.runtime.dispatch('shot.regenerate', f.input)).rejects.toThrow();
  expect(f.executeActivity).not.toHaveBeenCalled(); expect(f.provider).toHaveBeenCalledTimes(2);
});
