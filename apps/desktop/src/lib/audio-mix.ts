import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioLevelWindowSchema, audioMixJobSchema, audioMixPrepareResultSchema, type AssetRecord, type AudioLevelWindow, type AudioMixJob, type PreparedAudioMix, type ProjectDocument } from '@video-quickly/contracts';
import { audioMixProjection } from '@video-quickly/video/audio-projection';
import { rpc } from './client';

export class AudioMixRevisionChangedError extends Error {
  readonly expectedRevision: number;
  constructor(expectedRevision: number) {
    super('项目已有新修订，请先比较并合并项目修改，再重新准备试听。');
    this.name = 'AudioMixRevisionChangedError'; this.expectedRevision = expectedRevision;
  }
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); }, error => { signal.removeEventListener('abort', abort); if (!signal.aborted) reject(error); });
    if (signal.aborted) abort();
  });
}

function wait(signal: AbortSignal, delayMs = 400): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function preparedResult(job: AudioMixJob, project: ProjectDocument): PreparedAudioMix {
  const mix = job.result, durations = mix?.shotDurations;
  if (!mix || mix.key !== job.key || !durations || durations.length !== project.shots.length) throw new Error('试听混音与当前项目镜头不匹配，请重新准备。');
  let durationUs = 0;
  for (const [index, shot] of project.shots.entries()) {
    const mapped = durations[index], legacy = Boolean(shot.audioAssetId) && !shot.clipEdit && shot.sourceInUs === undefined && shot.audioInUs === undefined;
    if (mapped.shotId !== shot.id || mapped.durationUs < shot.durationUs || !legacy && mapped.durationUs !== shot.durationUs) throw new Error('试听混音与当前镜头时长不匹配，请重新准备。');
    durationUs += mapped.durationUs;
  }
  if (durationUs !== mix.durationUs) throw new Error('试听混音总时长与镜头不匹配，请重新准备。');
  return mix;
}

/** Aborting only ends this observer; the backend job may be shared by preview and export. */
export async function prepareAudioMixPreview(project: ProjectDocument, signal: AbortSignal, onJob?: (job: AudioMixJob) => void): Promise<PreparedAudioMix> {
  signal.throwIfAborted();
  const response = audioMixPrepareResultSchema.parse(await abortable(rpc('audio.mix.prepare', { project }), signal));
  if (response.status === 'revision_changed') throw new AudioMixRevisionChangedError(response.revision);
  let job = response;
  const id = job.id, key = job.key;
  for (;;) {
    signal.throwIfAborted();
    if (job.id !== id || job.key !== key) throw new Error('试听任务返回了其他混音结果，请重新准备。');
    onJob?.(job);
    if (job.status === 'succeeded') return preparedResult(job, project);
    if (job.status === 'failed') throw new Error(job.error ?? '试听混音准备失败，请重试。');
    await wait(signal);
    job = audioMixJobSchema.parse(await abortable(rpc('audio.mix.get', { jobId: id }), signal));
  }
}

/** Re-observe a synchronized draft once; revision observations never authorize rebasing it. */
export async function prepareLatestAudioMixPreview(readLatest: () => { project: ProjectDocument; projection?: string; deferPreparation?: boolean }, key: string, signal: AbortSignal): Promise<PreparedAudioMix | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const current = readLatest();
    if (current.projection !== key || current.deferPreparation) return;
    try {
      const mix = await prepareAudioMixPreview(current.project, signal);
      signal.throwIfAborted();
      const latest = readLatest();
      return latest.projection === key && !latest.deferPreparation ? mix : undefined;
    } catch (error) {
      signal.throwIfAborted();
      const current = readLatest();
      if (current.projection !== key || current.deferPreparation) return;
      if (!(error instanceof AudioMixRevisionChangedError) || attempt > 0) throw error;
      const deadline = Date.now() + 3_000;
      for (;;) {
        signal.throwIfAborted();
        const latest = readLatest();
        if (latest.projection !== key || latest.deferPreparation) return;
        if (latest.project.revision >= error.expectedRevision) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        await wait(signal, Math.min(100, remaining));
      }
    }
  }
}

export async function readAudioLevels(mix: PreparedAudioMix, startUs: number, durationUs: number, signal?: AbortSignal): Promise<AudioLevelWindow> {
  signal?.throwIfAborted();
  if (!Number.isInteger(startUs) || startUs < 0 || !Number.isInteger(durationUs) || durationUs <= 0 || durationUs > 60_000_000) throw new RangeError('电平读取范围须为正数，且不超过 60 秒。');
  const result = audioLevelWindowSchema.parse(await abortable(rpc('audio.mix.levels', { key: mix.key, startUs, durationUs }), signal));
  if (result.key !== mix.key || result.startUs !== Math.floor(startUs / 10_000) * 10_000 || result.samples.length > Math.ceil(durationUs / 10_000)) throw new Error('电平与当前混音或读取范围不匹配。');
  return result;
}

export interface PreparedProjectMixState {
  status: 'idle' | 'pending' | 'ready' | 'error'; mix?: PreparedAudioMix; error?: string; retry: () => void;
}

export function usePreparedProjectMix(project: ProjectDocument, assets: readonly AssetRecord[], enabled = true, deferPreparation = false): PreparedProjectMixState {
  const projection = useMemo(() => {
    try { return { key: audioMixProjection(project, assets), error: undefined }; }
    catch (error) { return { key: undefined, error: error instanceof Error ? error.message : String(error) }; }
  }, [project, assets]);
  const latest = useRef({ project, projection: projection.key, deferPreparation }); latest.current = { project, projection: projection.key, deferPreparation };
  const durationUs = project.shots.reduce((sum, shot) => sum + shot.durationUs, 0);
  const audible = project.shots.some(shot => Boolean(shot.audioAssetId)) || Boolean(project.musicClips?.some(clip => clip.startUs < durationUs));
  const active = enabled && project.shots.length > 0 && audible;
  const [attempt, setAttempt] = useState(0), retry = useCallback(() => setAttempt(value => value + 1), []);
  const [state, setState] = useState<{ projection: string; attempt: number; status: 'pending' | 'ready' | 'error'; mix?: PreparedAudioMix; error?: string }>();
  useEffect(() => {
    // A project write can advance the server revision before its reply reaches this editor.
    // Keep an unchanged ready mix, but schedule new dependencies only after that write settles.
    if (!active || !projection.key || deferPreparation) return;
    if (state?.projection === projection.key && state.status !== 'pending' && state.attempt === attempt) return;
    const key = projection.key, controller = new AbortController();
    setState({ projection: key, attempt, status: 'pending' });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mix = await prepareLatestAudioMixPreview(() => latest.current, key, controller.signal);
          if (mix && !controller.signal.aborted && latest.current.projection === key) setState({ projection: key, attempt, status: 'ready', mix });
        } catch (error) {
          if (controller.signal.aborted || latest.current.projection !== key) return;
          setState({ projection: key, attempt, status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      })();
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projection.key, active, attempt, deferPreparation]);
  if (!active) return { status: 'idle', retry };
  if (projection.error) return { status: 'error', error: projection.error, retry };
  if (!state || state.projection !== projection.key) return { status: 'pending', retry };
  return { status: state.status, mix: state.mix, error: state.error, retry };
}
