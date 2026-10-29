import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { audioMixPrepareResultSchema, DEFAULT_AUDIO_PROCESSING, projectSchema, type AssetRecord, type AudioMixJob, type PreparedAudioMix, type ProjectDocument } from '@video-quickly/contracts';
import { audioMixProjection } from '../packages/video/src/audio-projection';
import { createRuntime, type RuntimeOptions } from '../packages/runtime/src';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-audio-boundary-')); directories.push(directory);
  const calls = { prepare: 0, silence: 0, active: 0, maximum: 0, snapshots: [] as ProjectDocument[], hold: undefined as ReturnType<typeof gate> | undefined, entered: undefined as ReturnType<typeof gate> | undefined, invalidKey: false };
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider: async () => { throw new Error('派生音频绝不能调用模型。'); }, audioMix: {
    projectionKey: (project, assets) => hash(audioMixProjection(project, assets)),
    async prepare(input) {
      calls.prepare++; calls.active++; calls.maximum = Math.max(calls.maximum, calls.active); calls.snapshots.push(structuredClone(input.project)); calls.entered?.release();
      try {
        await calls.hold?.promise; input.signal.throwIfAborted(); input.onProgress(.3);
        const key = hash(audioMixProjection(input.project, input.assets)), path = join(input.outputDirectory, `${key}.wav`), bytes = Buffer.from(`isolated media callback: ${key}`);
        await writeFile(path, bytes); input.onProgress(1);
        return { version: 1, key: calls.invalidKey ? 'f'.repeat(64) : key, path, sha256: hash(bytes), durationUs: input.project.shots.reduce((sum, shot) => sum + shot.durationUs, 0), analysis: { sampleRate: 48000, channels: 2 }, warnings: [], shotDurations: input.project.shots.map(shot => ({ shotId: shot.id, durationUs: shot.durationUs })) };
      } finally { calls.active--; }
    },
    async levels({ mix, startUs }) { return { key: mix.key, startUs: Math.floor(startUs / 10_000) * 10_000, periodUs: 10_000, samples: [{ peakLeft: .5, peakRight: .4, rmsLeft: .2, rmsRight: .1 }] }; },
    async silence(input) {
      calls.silence++; calls.active++; calls.maximum = Math.max(calls.maximum, calls.active); calls.entered?.release();
      try { await calls.hold?.promise; input.signal.throwIfAborted(); return { assetId: input.asset.id, sourceSha256: input.asset.sha256, thresholdDb: input.thresholdDb, minimumDurationUs: input.minimumDurationUs, paddingUs: input.paddingUs, ranges: [{ startUs: 100_000, endUs: 300_000 }] }; }
      finally { calls.active--; }
    },
  }, ...extra };
  const open = () => { const runtime = createRuntime(options); runtimes.add(runtime); return runtime; };
  const runtime = open(), created = projectSchema.parse(await runtime.dispatch('project.create', { title: '声音派生边界' }));
  const path = join(directory, 'source.wav'); await writeFile(path, 'original local boundary bytes');
  const asset = await runtime.dispatch('asset.import', { path, projectId: created.id, kind: 'audio' }) as AssetRecord;
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [{ id: 'shot', title: '真实引用', narration: '', visualPrompt: '', durationUs: 2_000_000, sourceInUs: 0, audioAssetId: asset.id }] } }));
  const prepare = (projectOverride = project) => runtime.dispatch('audio.mix.prepare', { project: projectOverride }) as Promise<AudioMixJob>;
  return { runtime, directory, project, asset, calls, options, open, prepare };
}

it('deduplicates equal frozen drafts and serializes distinct snapshots without writing projects, runs or costs', async () => {
  const { runtime, project, calls, prepare } = await fixture(); calls.hold = gate(); calls.entered = gate();
  const first = await prepare(); await calls.entered.promise;
  const same = await Promise.all([prepare(), prepare()]); expect(same.every(job => job.id === first.id)).toBe(true);
  const draft = { ...project, shots: project.shots.map(shot => ({ ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: 3 } })) };
  const second = await prepare(draft); expect(second.key).not.toBe(first.key); expect(second.status).toBe('queued');
  const silence = runtime.dispatch('audio.silence', { projectId: project.id, shotId: 'shot', revision: project.revision, thresholdDb: -35, minimumDurationUs: 100_000, paddingUs: 20_000 });
  expect(calls.snapshots[0].shots[0].audioProcessing).toBeUndefined(); calls.hold.release(); await runtime.waitForIdle();
  expect(calls.prepare).toBe(2); expect(calls.maximum).toBe(1); expect(calls.snapshots[1].shots[0].audioProcessing?.gainDb).toBe(3);
  expect(await silence).toMatchObject({ ranges: [{ startUs: 100_000, endUs: 300_000 }] });
  expect(await runtime.dispatch('audio.mix.get', { jobId: first.id })).toMatchObject({ status: 'succeeded', key: first.key });
  expect(await runtime.dispatch('audio.mix.get', { jobId: second.id })).toMatchObject({ status: 'succeeded', key: second.key });
  expect((await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project).toEqual(project);
  expect(await runtime.dispatch('run.list', {})).toMatchObject({ items: [] }); expect(await runtime.dispatch('cost.list', {})).toMatchObject({ items: [] });
});

it('observes stale prepare revisions while still rejecting private foreign audio and changed source bytes', async () => {
  const { runtime, project, asset, calls, prepare } = await fixture();
  expect(audioMixPrepareResultSchema.parse(await prepare({ ...project, revision: project.revision - 1 }))).toEqual({ status: 'revision_changed', revision: project.revision });
  const foreign = projectSchema.parse(await runtime.dispatch('project.create', { title: '另一个项目' }));
  await expect(prepare({ ...project, id: foreign.id, revision: foreign.revision })).rejects.toThrow('不属于');
  await writeFile(asset.path, 'tampered source bytes'); await expect(prepare()).rejects.toThrow('校验失败');
  await expect(runtime.dispatch('audio.silence', { projectId: project.id, shotId: 'shot', revision: project.revision, thresholdDb: -35, minimumDurationUs: 100_000, paddingUs: 20_000 })).rejects.toThrow('校验失败');
  expect(calls.prepare).toBe(0); expect(calls.silence).toBe(0);
});

it('observes a revision advanced during source hashing without creating or persisting a fake job', async () => {
  const { runtime, project, directory, calls, prepare } = await fixture();
  const pending = prepare();
  const current = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '哈希期间的外部标题' } }));
  expect(await pending).toEqual({ status: 'revision_changed', revision: current.revision }); expect(calls.prepare).toBe(0);
  expect(await runtime.dispatch('run.list', {})).toMatchObject({ items: [] }); expect(await runtime.dispatch('cost.list', {})).toMatchObject({ items: [] });
  await runtime.close(); runtimes.delete(runtime);
  const database = openDatabase(directory);
  try { expect(new DocumentStore(database).list('audio-mix-job')).toEqual([]); } finally { database.close(); }
});

it.each([false, true])('rechecks revisions after asynchronous cache validation (damaged cache: %s) and retries only a fresh draft', async damaged => {
  const { runtime, project, calls, options, prepare } = await fixture(), first = await prepare(); await runtime.waitForIdle();
  const done = await runtime.dispatch('audio.mix.get', { jobId: first.id }) as AudioMixJob;
  if (damaged) await writeFile(done.result!.path, 'damaged cache before the external revision');
  const projectionKey = options.audioMix!.projectionKey;
  let update: Promise<unknown> | undefined;
  options.audioMix!.projectionKey = (value, assets) => {
    const key = projectionKey(value, assets);
    update ??= runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '缓存校验期间的外部标题' } });
    return key;
  };
  expect(await prepare()).toEqual({ status: 'revision_changed', revision: project.revision + 1 }); await update;
  expect(calls.prepare).toBe(1); expect(await runtime.dispatch('audio.mix.get', { jobId: first.id })).toEqual(done);
  const current = (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  const retried = await prepare(current); expect(retried.id).toBe(first.id); await runtime.waitForIdle();
  expect(calls.prepare).toBe(damaged ? 2 : 1); expect(await runtime.dispatch('audio.mix.get', { jobId: first.id })).toMatchObject({ status: 'succeeded' });
});

it('allows only registered keys and bounded 10ms level windows, never client supplied paths', async () => {
  const { runtime, prepare } = await fixture(), job = await prepare(); await runtime.waitForIdle();
  const levels = await runtime.dispatch('audio.mix.levels', { key: job.key, startUs: 12_345, durationUs: 20_000 });
  expect(levels).toMatchObject({ key: job.key, startUs: 10_000, samples: [{ peakLeft: .5 }] });
  await expect(runtime.dispatch('audio.mix.levels', { key: 'f'.repeat(64), startUs: 0, durationUs: 10_000 })).rejects.toThrow('尚未准备');
  await expect(runtime.dispatch('audio.mix.levels', { key: job.key, startUs: 0, durationUs: 60_000_001 })).rejects.toThrow();
  await expect(runtime.dispatch('audio.mix.levels', { key: job.key, startUs: 0, durationUs: 10_000, path: '/arbitrary/private/file' })).rejects.toThrow();
});

it('reuses verified completed caches after restart and rebuilds a corrupted derived file locally', async () => {
  const { runtime, calls, project, open, prepare } = await fixture(), first = await prepare(); await runtime.waitForIdle();
  const done = await runtime.dispatch('audio.mix.get', { jobId: first.id }) as AudioMixJob;
  await runtime.close(); runtimes.delete(runtime); const restarted = open();
  expect(await restarted.dispatch('audio.mix.prepare', { project })).toMatchObject({ id: first.id, status: 'succeeded' }); expect(calls.prepare).toBe(1);
  await writeFile(done.result!.path, 'damaged derived cache'); const rebuilt = await restarted.dispatch('audio.mix.prepare', { project }) as AudioMixJob;
  expect(rebuilt.id).toBe(first.id); await restarted.waitForIdle(); expect(calls.prepare).toBe(2);
  const result = (await restarted.dispatch('audio.mix.get', { jobId: first.id }) as AudioMixJob).result as PreparedAudioMix;
  expect(hash(await readFile(result.path))).toBe(result.sha256);
});

it('shows orphan preparation as interrupted after restart and waits for an explicit request', async () => {
  const { runtime, directory, calls, project, open, prepare } = await fixture(), first = await prepare(); await runtime.waitForIdle(); await runtime.close(); runtimes.delete(runtime);
  const db = openDatabase(directory), store = new DocumentStore(db), job = store.get<AudioMixJob>('audio-mix-job', first.id)!;
  store.put('audio-mix-job', first.id, { ...job, status: 'running', result: undefined }); db.close();
  const restarted = open(); expect(await restarted.dispatch('audio.mix.get', { jobId: first.id })).toMatchObject({ status: 'failed', error: expect.stringContaining('中断') });
  expect(calls.prepare).toBe(1); await restarted.dispatch('audio.mix.prepare', { project }); await restarted.waitForIdle(); expect(calls.prepare).toBe(2);
});

it('keeps invalid callback results failed and refuses silence candidates from a superseded revision', async () => {
  const { runtime, project, calls, prepare } = await fixture(); calls.invalidKey = true;
  const job = await prepare(); await runtime.waitForIdle(); expect(await runtime.dispatch('audio.mix.get', { jobId: job.id })).toMatchObject({ status: 'failed', error: expect.stringContaining('快照') });
  calls.hold = gate(); calls.entered = gate(); const request = runtime.dispatch('audio.silence', { projectId: project.id, shotId: 'shot', revision: project.revision, thresholdDb: -35, minimumDurationUs: 100_000, paddingUs: 20_000 });
  await calls.entered.promise; await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '检测期间外部修订' } }); calls.hold.release();
  await expect(request).rejects.toThrow('分析期间项目已更新');
});

it('retains only a compact legal audio snapshot instead of cloning research and full caption payloads per queued job', async () => {
  const { runtime, project, asset, calls, prepare } = await fixture();
  const content = '实际正文'.repeat(25_000);
  const draft = { ...project, researchSources: [{ id: 'large-text', title: '完整资料', kind: 'text' as const, content, sha256: hash(content), capturedAt: '2026-10-30T00:00:00.000Z' }], shots: project.shots.map(shot => ({ ...shot, captionTrack: { timeBase: 'source' as const, alignment: 'speech' as const, granularity: 'word' as const, sourceAssetId: asset.id, sourceSha256: asset.sha256, cues: Array.from({ length: 10_000 }, (_, index) => ({ id: `word-${index}`, text: '词', startUs: index * 100, endUs: index * 100 + 99 })) } })) };
  await prepare(draft); await runtime.waitForIdle();
  expect(projectSchema.safeParse(calls.snapshots[0]).success).toBe(true); expect(JSON.stringify(calls.snapshots[0]).length).toBeLessThan(5000);
  expect(calls.snapshots[0].researchSources).toBeUndefined(); expect(calls.snapshots[0].shots[0].captionTrack).toBeUndefined();
});

it('rejects a source-byte change during asynchronous processing instead of publishing it under the old hash', async () => {
  const { runtime, asset, calls, prepare } = await fixture(); calls.hold = gate(); calls.entered = gate();
  const job = await prepare(); await calls.entered.promise; await writeFile(asset.path, 'changed during processing'); calls.hold.release(); await runtime.waitForIdle();
  expect(await runtime.dispatch('audio.mix.get', { jobId: job.id })).toMatchObject({ status: 'failed', error: expect.stringContaining('校验失败') });
});

it('passes the same completed prepared mix to a matching export callback without another audio job', async () => {
  let observed: PreparedAudioMix | undefined;
  const { runtime, project, calls, prepare } = await fixture({ executeActivity: async context => { observed = context.preparedAudioMix; return { assets: [] }; } });
  const job = await prepare(); await runtime.waitForIdle();
  const done = await runtime.dispatch('audio.mix.get', { jobId: job.id }) as AudioMixJob;
  await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'export' }); await runtime.waitForIdle();
  expect(observed).toEqual(done.result); expect(calls.prepare).toBe(1);
  expect(await runtime.dispatch('cost.list', {})).toMatchObject({ items: [] });
});

it('aborts the active local callback on shutdown and leaves queued jobs failed after restart without auto processing', async () => {
  const { runtime, options, project, open, prepare } = await fixture(), entered = gate();
  let starts = 0, aborts = 0;
  options.audioMix!.prepare = async input => {
    starts++; entered.release();
    return new Promise<PreparedAudioMix>((_resolve, reject) => input.signal.addEventListener('abort', () => { aborts++; reject(new DOMException('isolated shutdown', 'AbortError')); }, { once: true }));
  };
  const first = await prepare(); await entered.promise;
  const queued = await prepare({ ...project, shots: project.shots.map(shot => ({ ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: 3 } })) });
  expect(queued.status).toBe('queued'); await runtime.close(); runtimes.delete(runtime);
  expect(starts).toBe(1); expect(aborts).toBe(1);
  const restarted = open(); expect(await restarted.dispatch('audio.mix.get', { jobId: first.id })).toMatchObject({ status: 'failed' });
  expect(await restarted.dispatch('audio.mix.get', { jobId: queued.id })).toMatchObject({ status: 'failed', error: expect.stringContaining('中断') }); expect(starts).toBe(1);
});
