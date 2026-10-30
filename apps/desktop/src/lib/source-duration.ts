import { useEffect, useState } from 'react';
import { usesVideoAudio, type AssetRecord, type Shot } from '@video-quickly/contracts';
import { commonSourceOutUs, type SourceDurations } from '@video-quickly/video/audio';
import type { ClipEditContext } from '@video-quickly/video/clip-edits';
import { getAssetUrl } from './client';

const durations = new Map<string, number>();

export type SourceDurationStatus = 'none' | 'loading' | 'ready' | 'error';
export interface SourceDurationResult { key: string; status: SourceDurationStatus; durationUs?: number; error?: string }

async function readDuration(asset: AssetRecord, signal: AbortSignal): Promise<number> {
  const cacheKey = JSON.stringify([asset.id, asset.version, asset.sha256, asset.path]);
  const cached = durations.get(cacheKey);
  if (cached !== undefined) return cached;
  const url = await getAssetUrl(asset.path);
  signal.throwIfAborted();
  return new Promise<number>((resolve, reject) => {
    // Metadata probing owns a detached element so it never seeks or pauses the preview.
    const element = document.createElement(asset.kind === 'video' ? 'video' : 'audio');
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute('src');
      element.load();
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const abort = () => fail(new DOMException('素材时长读取已取消。', 'AbortError'));
    const timeout = setTimeout(() => fail(new Error(`读取「${asset.name}」的素材时长超时，请重新选择素材后重试。`)), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const value = Math.round(element.duration * 1_000_000);
      if (!Number.isFinite(value) || value <= 0) { fail(new Error(`「${asset.name}」未提供有限时长，请重新导入素材。`)); return; }
      durations.set(cacheKey, value);
      cleanup();
      resolve(value);
    };
    element.onerror = () => fail(new Error(`无法读取「${asset.name}」的素材时长，请重新导入素材。`));
    element.src = url;
    element.load();
  });
}

function sourceIds(shots: readonly Shot[]) {
  return [...new Set(shots.flatMap(shot => [shot.audioAssetId, shot.sceneTemplate && !usesVideoAudio(shot) ? undefined : shot.videoAssetId]).filter((id): id is string => Boolean(id)))].sort();
}

export function sourceDurationsKey(shots: readonly Shot[], assets: readonly AssetRecord[]): string {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return JSON.stringify(sourceIds(shots).map(id => { const asset = byId.get(id); return asset ? [id, asset.kind, asset.version, asset.sha256, asset.path, asset.active] : [id, 'missing']; }));
}

export async function readSourceDurations(shots: readonly Shot[], assets: readonly AssetRecord[], signal: AbortSignal): Promise<Record<string, number>> {
  const byId = new Map(assets.map(asset => [asset.id, asset])), ids = sourceIds(shots);
  const result: Record<string, number> = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      signal.throwIfAborted();
      const id = ids[next++], asset = byId.get(id);
      if (!asset?.active || !['audio', 'video'].includes(asset.kind)) throw new Error('关联的音视频素材已缺失，请重新选择或导入素材。');
      result[id] = await readDuration(asset, signal);
    }
  }));
  return result;
}

export function useBulkSourceDurations(shots: readonly Shot[], assets: readonly AssetRecord[], enabled: boolean) {
  const key = sourceDurationsKey(shots, assets);
  const [result, setResult] = useState<{ key: string; durations?: Record<string, number>; error?: string }>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void readSourceDurations(shots, assets, controller.signal).then(durations => {
      if (!controller.signal.aborted) setResult({ key, durations });
    }).catch(error => {
      if (controller.signal.aborted) return;
      controller.abort();
      setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [key, enabled]);
  if (!enabled) return { key, status: 'none' as const, durations: {} };
  if (result?.key !== key) return { key, status: 'loading' as const, durations: {} };
  return result.error ? { key, status: 'error' as const, error: result.error, durations: {} } : { key, status: 'ready' as const, durations: result.durations ?? {} };
}

export function useSourceDuration(shot: (Pick<Shot, 'videoAssetId' | 'audioAssetId' | 'sourceInUs' | 'audioInUs' | 'videoInUs' | 'sceneTemplate' | 'audioProcessing'> & Partial<Pick<Shot, 'clipEdit' | 'durationUs'>>) | undefined, assets: AssetRecord[], context: ClipEditContext = {}): SourceDurationResult {
  const videoId = shot?.sceneTemplate && !usesVideoAudio(shot) ? undefined : shot?.videoAssetId;
  const video = assets.find(asset => asset.id === videoId);
  const audio = assets.find(asset => asset.id === shot?.audioAssetId);
  const media = [video, audio].filter((asset): asset is AssetRecord => !!asset);
  const hasMedia = Boolean(videoId || shot?.audioAssetId);
  const missingMedia = Boolean(videoId && !video?.active || shot?.audioAssetId && !audio?.active);
  const key = JSON.stringify([videoId, shot?.audioAssetId, ...media.map(asset => [asset.id, asset.version, asset.sha256, asset.path, asset.name, asset.active])]);
  const [result, setResult] = useState<{ key: string; status: 'ready' | 'error'; durations?: SourceDurations; error?: string }>();
  useEffect(() => {
    if (!hasMedia || missingMedia) return;
    const controller = new AbortController();
    void Promise.all(media.map(asset => readDuration(asset, controller.signal))).then(values => {
      if (!controller.signal.aborted) setResult({ key, status: 'ready', durations: { videoDurationUs: video ? values[media.indexOf(video)] : undefined, audioDurationUs: audio ? values[media.indexOf(audio)] : undefined } });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, status: 'error', error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [key]);
  if (!hasMedia) return { key, status: 'none' };
  if (missingMedia) return { key, status: 'error', error: '关联的素材已缺失，请重新选择或导入素材。' };
  // New associations must block trimming in the same render, before the effect starts.
  if (result?.key !== key) return { key, status: 'loading' };
  if (result.status === 'error') return { key, status: 'error', error: result.error };
  try {
    const durationUs = commonSourceOutUs(shot ?? {}, result.durations ?? {}, context);
    if (durationUs === undefined || durationUs <= (shot?.clipEdit?.inUs ?? shot?.sourceInUs ?? 0)) return { key, status: 'error', error: '当前音视频入点之后没有可用素材，请重新选择素材。' };
    return { key, status: 'ready', durationUs };
  } catch (error) { return { key, status: 'error', error: error instanceof Error ? error.message : String(error) }; }
}
