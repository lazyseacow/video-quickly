import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, createSceneTemplate, DEFAULT_VIDEO_PROFILE, exportBatchSchema, projectSchema, runSchema, type AssetRecord, type ExportBatch, type ProjectDocument, type UsageRecord } from '@video-quickly/contracts';
import { createActivityExecutor } from '../packages/integrations/src';
import { createRuntime, type ActivityExecutionContext, type RuntimeOptions } from '../packages/runtime/src';
import { batchTargetDirectory } from '../packages/runtime/src/export-batches';
import { probeMedia } from '../packages/video/src/node';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync(ffprobe, ['-version'], { stdio: 'ignore' }).status === 0;
const directories: string[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const targets = [
  { id: 'wide', label: '横屏', profile: { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180 } },
  { id: 'portrait', label: '竖屏', profile: { ...DEFAULT_VIDEO_PROFILE, width: 180, height: 320 } },
  { id: 'square', label: '方形', profile: { ...DEFAULT_VIDEO_PROFILE, width: 256, height: 256 } },
];
function open(directory: string, extra: Partial<RuntimeOptions> = {}) { const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: mediaAvailable ? ffmpeg : '/unused', executeActivity: artifacts, ...extra }); runtimes.add(runtime); return runtime; }
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-batch-')); directories.push(directory);
  const runtime = open(directory, extra);
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '冻结的批导出内容', templateId: 'generic', profile: targets[0].profile }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [{ id: 'shot', title: '冻结镜头', narration: '', visualPrompt: '', durationUs: 500_000, sceneTemplate: createSceneTemplate('bar-chart') }] } }));
  return { directory, runtime, project };
}
async function start(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, extra: Record<string, unknown> = {}) { return exportBatchSchema.parse(await runtime.dispatch('render.batch.start', { projectId: project.id, revision: project.revision, targets, ...extra })); }
async function get(runtime: ReturnType<typeof createRuntime>, id: string) { return exportBatchSchema.parse(await runtime.dispatch('render.batch.get', { batchId: id })); }
async function artifacts(context: ActivityExecutionContext) {
  const directory = join(context.dataDirectory, 'callback-output', createHash('sha256').update(context.operationId).digest('hex').slice(0, 16)); await mkdir(directory, { recursive: true });
  const assets: AssetRecord[] = [];
  const output: Record<string, unknown> = {};
  for (const [field, kind, extension] of [['videoPath', 'video', 'mp4'], ['coverPath', 'image', 'png'], ['subtitlePath', 'subtitle', 'srt'], ['timelinePath', 'document', 'json']] as const) {
    const path = join(directory, `${kind}.${extension}`), bytes = Buffer.from(`${context.project.title}:${context.project.profile.width}:${kind}`); await writeFile(path, bytes);
    assets.push({ id: `${context.runId}-${kind}`, projectId: context.project.id, name: `${kind}.${extension}`, kind, path, mimeType: 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'controlled local export boundary', retained: false, active: true }); output[field] = path;
  }
  context.onProgress?.(.5); context.onProgress?.(1);
  return { ...output, assets } as unknown as Awaited<ReturnType<NonNullable<RuntimeOptions['executeActivity']>>>;
}
function deferred() { let resolve = () => {}; const promise = new Promise<void>(ready => { resolve = ready; }); return { promise, resolve }; }

it.skipIf(!mediaAvailable)('really renders landscape, portrait and square from the initial snapshot despite later project edits', async () => {
  const seen: ProjectDocument[] = [], execute = createActivityExecutor({ ffmpegPath: ffmpeg });
  const { runtime, project } = await fixture({ executeActivity: async context => { expect(context.model).toBeUndefined(); seen.push(context.project); return execute(context); } });
  // A template owns the visible picture; a missing dormant visual must not block its export.
  const templated = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, videoAssetId: 'missing-dormant-video', assetId: 'missing-dormant-image' })) } }));
  const batch = await start(runtime, templated);
  const edited = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: templated.revision, patch: { title: '启动后人工改名', shots: templated.shots.map(shot => ({ ...shot, title: '启动后人工改镜头', sceneTemplate: createSceneTemplate('process') })) } }));
  await runtime.waitForIdle(); const completed = await get(runtime, batch.id);
  expect(completed.status).toBe('succeeded'); expect(seen).toHaveLength(3); expect(seen.every(value => value.title === templated.title && value.shots[0].sceneTemplate?.kind === 'bar-chart')).toBe(true);
  for (const target of completed.targets) {
    const probe = await probeMedia(target.videoPath!, ffprobe); expect(probe).toMatchObject({ width: target.profile.width, height: target.profile.height }); expect(probe.videoDuration).toBeCloseTo(.5, 1);
    expect(relative(completed.destinationDirectory!, target.videoPath!).startsWith('..')).toBe(false);
    const timeline = JSON.parse(await readFile(target.timelinePath!, 'utf8')) as { profile: unknown }; expect(timeline.profile).toEqual(target.profile);
    expect(target.progress).toBe(1); expect(target.runId).toBeTruthy();
  }
  expect((await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project).toEqual(edited);
  expect((await runtime.dispatch('cost.list', { projectId: project.id }) as { items: UsageRecord[] }).items).toEqual([]);
}, 90_000);

it('continues after one target fails and resumes only that target with the same run', async () => {
  let fail = true; const calls: number[] = [];
  const { runtime, project } = await fixture({ executeActivity: async context => { calls.push(context.project.profile.width); if (fail && context.project.profile.width === 180) throw new Error('本地编码夹具失败'); return artifacts(context); } });
  const batch = await start(runtime, project); await runtime.waitForIdle(); const partial = await get(runtime, batch.id);
  expect(partial.status).toBe('partial'); expect(partial.targets.map(target => target.status)).toEqual(['succeeded', 'failed', 'succeeded']); expect(partial.targets[1].error).toContain('本地编码夹具失败');
  const first = await stat(partial.targets[0].videoPath!); fail = false;
  await runtime.dispatch('render.batch.resume', { batchId: batch.id }); await runtime.waitForIdle(); const completed = await get(runtime, batch.id);
  expect(completed.status).toBe('succeeded'); expect(completed.targets[1].runId).toBe(partial.targets[1].runId); expect(calls).toEqual([320, 180, 256, 180]); expect((await stat(completed.targets[0].videoPath!)).mtimeMs).toBe(first.mtimeMs);
});

it('settles cancellation before returning and supports an immediate concurrent resume without redoing completed targets', async () => {
  let hold = true; const portraitStarted = deferred(), calls: number[] = [];
  const { runtime, project } = await fixture({ executeActivity: async context => {
    calls.push(context.project.profile.width);
    if (hold && context.project.profile.width === 180) { context.signal.throwIfAborted(); portraitStarted.resolve(); await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('local canceled')), { once: true })); }
    return artifacts(context);
  } });
  const batch = await start(runtime, project); await portraitStarted.promise;
  expect((await get(runtime, batch.id)).targets[0].status).toBe('succeeded'); hold = false;
  const canceling = runtime.dispatch('render.batch.cancel', { batchId: batch.id }), resuming = runtime.dispatch('render.batch.resume', { batchId: batch.id });
  const canceled = exportBatchSchema.parse(await canceling); expect(canceled.targets.some(target => target.status === 'running')).toBe(false);
  await resuming; await runtime.waitForIdle(); const completed = await get(runtime, batch.id);
  expect(completed.status).toBe('succeeded'); expect(calls).toEqual([320, 180, 180, 256]);
});

it('shows interrupted batches after restart without automatic rendering, then resumes the original snapshot', async () => {
  const entered = deferred(), calls: string[] = [];
  const { runtime: first, directory, project } = await fixture({ executeActivity: async context => { context.signal.throwIfAborted(); entered.resolve(); calls.push(context.project.title); await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true })); return artifacts(context); } });
  const batch = await start(first, project); await entered.promise;
  await first.close(); runtimes.delete(first);
  const second = open(directory, { executeActivity: async context => { calls.push(context.project.title); return artifacts(context); } });
  const restored = await get(second, batch.id); expect(restored.status).toBe('interrupted'); expect(calls).toHaveLength(1);
  await expect(second.dispatch('run.start', { projectId: project.id, nodeId: 'brief' })).rejects.toThrow('批量导出');
  await second.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { title: '重启后的人工修改' } });
  await second.dispatch('render.batch.resume', { batchId: batch.id }); await second.waitForIdle();
  expect((await get(second, batch.id)).status).toBe('succeeded'); expect(calls).toEqual([project.title, project.title, project.title, project.title]);
});

it('never overwrites an unrelated target output and can publish its already-rendered local result after the obstacle is removed', async () => {
  const gate = deferred(); let calls = 0;
  const { runtime, project } = await fixture({ executeActivity: async context => { calls++; if (calls === 1) await gate.promise; return artifacts(context); } });
  const batch = await start(runtime, project, { targets: targets.slice(0, 2) });
  const obstacle = join(batchTargetDirectory(batch.destinationDirectory!, targets[1].id), 'video.mp4'); await mkdir(dirname(obstacle), { recursive: true }); await writeFile(obstacle, 'pre-existing user output'); gate.resolve();
  await runtime.waitForIdle(); const partial = await get(runtime, batch.id); expect(partial.status).toBe('partial'); expect(await readFile(obstacle, 'utf8')).toBe('pre-existing user output');
  await rm(obstacle); await runtime.dispatch('render.batch.resume', { batchId: batch.id }); await runtime.waitForIdle();
  expect((await get(runtime, batch.id)).status).toBe('succeeded'); expect(calls).toBe(2);
});

it('validates completed hashes and rebuilds only a damaged local target without a new run', async () => {
  const calls: number[] = [];
  const { runtime, project } = await fixture({ executeActivity: async context => { calls.push(context.project.profile.width); return artifacts(context); } });
  const batch = await start(runtime, project, { targets: targets.slice(0, 2) }); await runtime.waitForIdle(); const completed = await get(runtime, batch.id);
  const firstMtime = (await stat(completed.targets[0].videoPath!)).mtimeMs;
  const result = await runtime.dispatch('node.result', { runId: completed.targets[1].runId, nodeId: 'export' }) as { videoPath: string };
  await writeFile(completed.targets[1].videoPath!, 'damaged published copy'); await writeFile(result.videoPath, 'damaged internal render');
  await runtime.dispatch('render.batch.resume', { batchId: batch.id }); await runtime.waitForIdle(); const repaired = await get(runtime, batch.id);
  expect(repaired.status).toBe('succeeded'); expect(repaired.targets[1].runId).toBe(completed.targets[1].runId); expect(calls).toEqual([320, 180, 180]); expect((await stat(repaired.targets[0].videoPath!)).mtimeMs).toBe(firstMtime);
});

it('uses bounded batch list pages, rejects stale starts, and shares the project run lock', async () => {
  const gate = deferred();
  const { runtime, project } = await fixture({ executeActivity: async context => { await gate.promise; return artifacts(context); } });
  await expect(start(runtime, { ...project, revision: project.revision - 1 })).rejects.toThrow('其他视图修改');
  const first = await start(runtime, project, { targets: [targets[0]] });
  await expect(runtime.dispatch('run.start', { projectId: project.id, nodeId: 'brief' })).rejects.toThrow('批量导出');
  await expect(start(runtime, project)).rejects.toThrow('未完成'); gate.resolve(); await runtime.waitForIdle();
  const second = await start(runtime, project, { targets: [targets[1]] }); await runtime.waitForIdle();
  const page = await runtime.dispatch('render.batch.list', { projectId: project.id, limit: 1 }) as { items: ExportBatch[]; nextCursor: number };
  expect(page.items[0].id).toBe(second.id); expect(JSON.stringify(page)).not.toContain('"shots"');
  const next = await runtime.dispatch('render.batch.list', { projectId: project.id, before: page.nextCursor, limit: 1 }) as { items: ExportBatch[]; nextCursor: null };
  expect(next.items[0].id).toBe(first.id); expect(next.nextCursor).toBeNull();
});

it('fails changed frozen input hashes without silently consuming a later asset and resumes when the original is restored', async () => {
  let calls = 0, source: AssetRecord | undefined; const gate = deferred(), entered = deferred();
  const { runtime, project, directory } = await fixture({ executeActivity: async context => { calls++; if (calls === 1) { entered.resolve(); await gate.promise; } return artifacts(context); } });
  const path = join(directory, 'source.png'); const original = Buffer.from('original frozen image'); await writeFile(path, original);
  source = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: project.id, path, kind: 'image' }));
  const linked = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, sceneTemplate: undefined, assetId: source!.id })) } }));
  const batch = await start(runtime, linked, { targets: targets.slice(0, 2) }); await entered.promise; expect(calls).toBe(1);
  await writeFile(source.path, Buffer.alloc(original.length, 1)); gate.resolve(); await runtime.waitForIdle();
  const partial = await get(runtime, batch.id); expect(partial.status).toBe('partial'); expect(partial.targets[1].error).toContain('校验失败'); expect(calls).toBe(1);
  await writeFile(source.path, original); await runtime.dispatch('render.batch.resume', { batchId: batch.id }); await runtime.waitForIdle(); expect((await get(runtime, batch.id)).status).toBe('succeeded'); expect(calls).toBe(2);
});

it('keeps run.resume and run.cancel responses as RunRecord while delegating batch scheduling', async () => {
  let hold = true; const entered = deferred();
  const { runtime, project } = await fixture({ executeActivity: async context => {
    if (hold) { context.signal.throwIfAborted(); entered.resolve(); await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true })); }
    return artifacts(context);
  } });
  const batch = await start(runtime, project, { targets: [targets[0]] }); await entered.promise;
  const runId = (await get(runtime, batch.id)).targets[0].runId!;
  const canceled = runSchema.parse(await runtime.dispatch('run.cancel', { runId }));
  expect(canceled).toMatchObject({ id: runId, projectId: project.id, projectRevision: project.revision });
  hold = false;
  const resumed = runSchema.parse(await runtime.dispatch('run.resume', { runId }));
  expect(resumed.id).toBe(runId); await runtime.waitForIdle(); expect((await get(runtime, batch.id)).status).toBe('succeeded');
});
