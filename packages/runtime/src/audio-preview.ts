import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { audioLevelWindowSchema, audioMixJobSchema, preparedAudioMixSchema, projectSchema, silenceDetectionSchema, workflowSchema, type AssetRecord, type AudioLevelWindow, type AudioMixJob, type AudioMixPrepareResult, type PreparedAudioMix, type ProjectDocument, type SilenceDetection } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';

export interface AudioMixCallbacks {
  projectionKey(project: ProjectDocument, assets: readonly AssetRecord[]): string;
  prepare(options: { project: ProjectDocument; assets: readonly AssetRecord[]; outputDirectory: string; signal: AbortSignal; onProgress(value: number): void }): Promise<PreparedAudioMix>;
  levels(options: { mix: PreparedAudioMix; startUs: number; durationUs: number }): Promise<AudioLevelWindow>;
  silence(options: { asset: AssetRecord; thresholdDb: number; minimumDurationUs: number; paddingUs: number; signal: AbortSignal }): Promise<SilenceDetection>;
}
export async function audioFileHash(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal?.throwIfAborted(); return hash.digest('hex');
}

/** Audio jobs retain timing and DSP, never research text, prompts or full subtitle tracks. */
export function compactAudioProject(project: ProjectDocument): ProjectDocument {
  const planIds = new Set(project.shots.flatMap(shot => shot.clipEdit ? [shot.clipEdit.planId] : []));
  const plans = (project.clipEditPlans ?? []).filter(plan => planIds.has(plan.id)), sourceIds = new Set(plans.map(plan => plan.sourceId));
  return { ...project, title: '声音试听', brief: '', style: '', claims: [], researchSources: undefined, referenceDisplay: undefined,
    shots: project.shots.map(shot => ({ ...shot, title: '声音片段', narration: '', visualPrompt: '', captionTrack: undefined, sceneTemplate: undefined, characterIds: undefined, claimIds: [], assetId: undefined, videoAssetId: undefined })),
    clipEditPlans: structuredClone(plans),
    clipEditSources: (project.clipEditSources ?? []).filter(source => sourceIds.has(source.id)).map(source => ({ ...source, original: { ...source.original, captionTrack: source.original.captionTrack ? { ...source.original.captionTrack, cues: [] } : undefined }, assetHashes: structuredClone(source.assetHashes) })),
    audioMix: structuredClone(project.audioMix), musicClips: structuredClone(project.musicClips),
    workflow: workflowSchema.parse({ id: 'audio-preview', version: 1, name: '声音试听', nodes: [{ id: 'audio-preview', kind: 'export', label: '声音试听' }], edges: [] }) };
}

export function createAudioPreview(options: {
  directory: string; store: DocumentStore; callbacks?: AudioMixCallbacks;
  project(id: string): ProjectDocument;
  validate(project: ProjectDocument): void;
}) {
  const { store } = options, directory = resolve(options.directory, 'derived', 'audio-mixes');
  const jobs = new Map<string, AudioMixJob>(), byKey = new Map<string, string>();
  const queued: Array<{ id: string; project: ProjectDocument; assets: AssetRecord[] }> = [];
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let mediaTail = Promise.resolve();
  async function media<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mediaTail; let release!: () => void;
    mediaTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  let running: Promise<void> | undefined, closing = false;
  for (const saved of store.list<AudioMixJob>('audio-mix-job')) {
    const job = audioMixJobSchema.parse(saved);
    const restored = ['queued', 'running'].includes(job.status) ? { ...job, status: 'failed' as const, error: '上次试听准备已中断，请重新准备。' } : job;
    jobs.set(job.id, restored); byKey.set(job.key, job.id);
    if (restored !== job) store.put('audio-mix-job', job.id, restored);
  }
  function save(job: AudioMixJob) { jobs.set(job.id, job); store.put('audio-mix-job', job.id, job); return structuredClone(job); }
  function callbacks() { if (!options.callbacks) throw new Error('音频处理器尚未连接。'); return options.callbacks; }
  function revisionChanged(project: ProjectDocument): Extract<AudioMixPrepareResult, { status: 'revision_changed' }> | undefined {
    const current = options.project(project.id);
    return current.revision === project.revision ? undefined : { status: 'revision_changed', revision: current.revision };
  }
  function currentAssets(project: ProjectDocument): AssetRecord[] {
    const ids = new Set([...project.shots.map(shot => shot.audioAssetId), ...(project.musicClips ?? []).map(clip => clip.assetId)].filter((id): id is string => Boolean(id)));
    return [...ids].map(id => {
      const asset = store.get<AssetRecord>('asset', id);
      if (!asset?.active || asset.kind !== 'audio' || asset.projectId && asset.projectId !== project.id) throw new Error('试听引用的音频已移除或不属于当前项目。');
      return asset;
    });
  }
  function recheck(assets: readonly AssetRecord[]) {
    for (const asset of assets) {
      const current = store.get<AssetRecord>('asset', asset.id);
      if (!current?.active || ['sha256', 'version', 'path', 'projectId', 'kind'].some(key => current[key as keyof AssetRecord] !== asset[key as keyof AssetRecord])) throw new Error('读取期间音频素材已更新，请重新准备试听。');
    }
  }
  async function verify(assets: readonly AssetRecord[], signal?: AbortSignal) {
    for (const asset of assets) if (await audioFileHash(asset.path, signal) !== asset.sha256) throw new Error(`音频「${asset.name}」校验失败，请重新导入。`);
    recheck(assets);
  }
  async function verifyResult(result: PreparedAudioMix) {
    const remainder = relative(directory, resolve(result.path));
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder) || !(await stat(result.path)).isFile() || await audioFileHash(result.path) !== result.sha256) throw new Error('试听缓存缺失或校验失败，请重新准备。');
  }
  function verifyMapping(result: PreparedAudioMix, project: ProjectDocument, key: string) {
    if (result.key !== key) throw new Error('试听缓存与请求快照不匹配。');
    if (!result.shotDurations || result.shotDurations.length !== project.shots.length || result.shotDurations.some((value, index) => {
      const shot = project.shots[index], legacy = Boolean(shot.audioAssetId && !shot.clipEdit && shot.sourceInUs === undefined && shot.audioInUs === undefined);
      return value.shotId !== shot.id || (legacy ? value.durationUs < shot.durationUs : value.durationUs !== shot.durationUs);
    }) || result.shotDurations.reduce((sum, value) => sum + value.durationUs, 0) !== result.durationUs) throw new Error('试听缓存缺少准确的镜头时间映射。');
  }
  function start() {
    if (running || closing || !queued.length) return;
    running = (async () => {
      while (!closing && queued.length) {
        const work = queued.shift()!, initial = jobs.get(work.id)!;
        const controller = new AbortController(); controllers.add(controller);
        save({ ...initial, status: 'running', progress: 0, error: undefined });
        try {
          await mkdir(directory, { recursive: true }); await verify(work.assets, controller.signal);
          let lastProgress = 0, lastSavedAt = Date.now();
          const result = preparedAudioMixSchema.parse(await media(() => { controller.signal.throwIfAborted(); return callbacks().prepare({ project: work.project, assets: work.assets, outputDirectory: directory, signal: controller.signal, onProgress(value) {
            const progress = Math.max(lastProgress, Math.min(1, Number.isFinite(value) ? value : 0));
            if (progress < 1 && progress - lastProgress < .02 && Date.now() - lastSavedAt < 300) return;
            lastProgress = progress; lastSavedAt = Date.now(); save({ ...jobs.get(work.id)!, progress });
          } }); }));
          verifyMapping(result, work.project, initial.key);
          await verify(work.assets, controller.signal); await verifyResult(result); controller.signal.throwIfAborted();
          save({ ...initial, status: 'succeeded', progress: 1, result, error: undefined });
        } catch (error) { save({ ...initial, status: 'failed', error: error instanceof Error ? error.message : String(error), result: undefined }); }
        finally { controllers.delete(controller); }
      }
    })().finally(() => { running = undefined; if (!closing && queued.length) start(); });
  }
  async function perform(method: string, raw: unknown): Promise<unknown> {
    if (closing) throw new Error('音频处理器已关闭。');
    if (method === 'audio.mix.prepare') {
      const { project } = z.object({ project: projectSchema }).parse(raw), initialChange = revisionChanged(project);
      if (initialChange) return initialChange;
      options.validate(project);
      const assets = currentAssets(project); await verify(assets);
      if (closing) throw new Error('音频处理器已关闭。');
      const readChange = revisionChanged(project);
      if (readChange) return readChange;
      const key = preparedAudioMixSchema.shape.key.parse(callbacks().projectionKey(project, assets));
      const existing = byKey.get(key), previous = existing ? jobs.get(existing) : undefined;
      if (previous && ['queued', 'running'].includes(previous.status)) return structuredClone(previous);
      if (previous?.status === 'succeeded' && previous.result) {
        let valid = false;
        try { verifyMapping(previous.result, project, key); await verifyResult(previous.result); valid = true; }
        catch { /* Rebuild a damaged local derived cache using the same frozen draft. */ }
        recheck(assets);
        const cacheChange = revisionChanged(project);
        if (cacheChange) return cacheChange;
        if (valid) return structuredClone(previous);
      }
      const latest = jobs.get(byKey.get(key) ?? '');
      if (latest && ['queued', 'running'].includes(latest.status)) return structuredClone(latest);
      if (closing) throw new Error('音频处理器已关闭。');
      recheck(assets);
      const queueChange = revisionChanged(project);
      if (queueChange) return queueChange;
      const snapshot = compactAudioProject(project);
      if (callbacks().projectionKey(snapshot, assets) !== key) throw new Error('音频处理器使用了无法安全冻结的非音频项目字段。');
      const job = save({ id: previous?.id ?? randomUUID(), key, status: 'queued', progress: 0 });
      byKey.set(key, job.id); queued.push({ id: job.id, project: snapshot, assets: structuredClone(assets) }); start(); return job;
    }
    if (method === 'audio.mix.get') {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(raw), job = jobs.get(jobId);
      if (!job) throw new Error('试听任务不存在，请重新准备。'); return structuredClone(job);
    }
    if (method === 'audio.mix.levels') {
      const input = z.object({ key: preparedAudioMixSchema.shape.key, startUs: z.number().int().nonnegative(), durationUs: z.number().int().positive().max(60_000_000) }).strict().parse(raw);
      const job = jobs.get(byKey.get(input.key) ?? '');
      if (job?.status !== 'succeeded' || !job.result) throw new Error('试听尚未准备完成，请稍后读取电平。');
      const result = audioLevelWindowSchema.parse(await callbacks().levels({ mix: job.result, startUs: input.startUs, durationUs: input.durationUs }));
      if (result.key !== input.key || result.startUs !== Math.floor(input.startUs / 10_000) * 10_000 || result.samples.length > Math.ceil(input.durationUs / 10_000)) throw new Error('电平数据与当前试听窗口不匹配。');
      return result;
    }
    if (method === 'audio.silence') {
      const input = z.object({ projectId: z.string().min(1), shotId: z.string().min(1), revision: z.number().int().positive(), thresholdDb: silenceDetectionSchema.shape.thresholdDb, minimumDurationUs: silenceDetectionSchema.shape.minimumDurationUs, paddingUs: silenceDetectionSchema.shape.paddingUs }).parse(raw);
      const project = options.project(input.projectId);
      if (project.revision !== input.revision) throw new Error('项目已有新修订，请重新读取后分析停顿。');
      const shot = project.shots.find(value => value.id === input.shotId), asset = shot?.audioAssetId ? store.get<AssetRecord>('asset', shot.audioAssetId) : undefined;
      if (!asset?.active || asset.kind !== 'audio' || asset.projectId && asset.projectId !== project.id) throw new Error('请先关联有效的旁白音频。');
      await verify([asset]);
      if (closing) throw new Error('音频处理器已关闭。');
      const controller = new AbortController(); controllers.add(controller);
      try {
        const result = silenceDetectionSchema.parse(await media(() => { controller.signal.throwIfAborted(); return callbacks().silence({ asset, ...input, signal: controller.signal }); }));
        await verify([asset], controller.signal); if (options.project(input.projectId).revision !== input.revision) throw new Error('分析期间项目已更新，请重新分析停顿。');
        if (result.assetId !== asset.id || result.sourceSha256 !== asset.sha256 || result.thresholdDb !== input.thresholdDb || result.minimumDurationUs !== input.minimumDurationUs || result.paddingUs !== input.paddingUs) throw new Error('停顿候选与原始音频不匹配。'); return result;
      } finally { controllers.delete(controller); }
    }
    throw new Error('未知音频操作。');
  }
  return { ready(project: ProjectDocument, assets: readonly AssetRecord[]) { const key = options.callbacks?.projectionKey(project, assets), job = key ? jobs.get(byKey.get(key) ?? '') : undefined; if (!key || job?.status !== 'succeeded' || !job.result) return undefined; try { verifyMapping(job.result, project, key); return structuredClone(job.result); } catch { return undefined; } },
    dispatch(method: string, raw: unknown) { const promise = perform(method, raw); pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; },
    async waitForIdle() { while (running) await running; },
    async close() { closing = true; queued.length = 0; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending, ...(running ? [running] : [])]); } };
}
