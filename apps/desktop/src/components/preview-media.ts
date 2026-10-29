import type { AssetRecord } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';

interface CachedImage { image: Promise<HTMLImageElement>; pixels: number }
const imageCache = new Map<string, CachedImage>();
const MAX_CACHED_IMAGES = 12;
const MAX_CACHED_PIXELS = 16_000_000;

export function previewAssetKey(asset: AssetRecord): string {
  return JSON.stringify([asset.id, asset.version, asset.sha256, asset.path]);
}

function trimImageCache(): void {
  let pixels = [...imageCache.values()].reduce((total, entry) => total + entry.pixels, 0);
  for (const [key, entry] of imageCache) {
    if (imageCache.size <= MAX_CACHED_IMAGES && pixels <= MAX_CACHED_PIXELS) break;
    imageCache.delete(key);
    pixels -= entry.pixels;
  }
}

export function loadPreviewImage(asset: AssetRecord, refresh = false): Promise<HTMLImageElement> {
  const key = previewAssetKey(asset);
  if (refresh) imageCache.delete(key);
  const cached = imageCache.get(key);
  if (cached) {
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached.image;
  }
  const entry: CachedImage = { pixels: 0, image: getAssetUrl(asset.path).then(url => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      entry.pixels = image.naturalWidth * image.naturalHeight;
      trimImageCache();
      resolve(image);
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('图片素材无法读取或解码'));
    };
    image.src = url;
  })).catch(error => {
    if (imageCache.get(key) === entry) imageCache.delete(key);
    throw error;
  }) };
  imageCache.set(key, entry);
  trimImageCache();
  return entry.image;
}

export interface PreviewVideoRange { startUs: number; endUs: number }

export function previewFrameInRange(mediaTime: number, range: PreviewVideoRange): boolean {
  const timeUs = Math.round(mediaTime * 1_000_000);
  return Number.isFinite(timeUs) && timeUs >= range.startUs && timeUs < range.endUs;
}

export function createPreviewVideoController(element: HTMLVideoElement, events: { onFrame: () => void; onReady: () => void; onError: (message: string) => void; frameSize?: () => { width: number; height: number } }) {
  let active = true, ready = false, targetTime = 0, playing = false, frameDuration = 1 / 30;
  let frameRequest: number | undefined, playRequest: Promise<void> | undefined, discontinuityKey: string | undefined;
  let playFailed = false, forceSeek = false, boundaryBlocked = false, seekGeneration = 0;
  let range: PreviewVideoRange | undefined, safeFrame: HTMLCanvasElement | undefined, safeSampleUs: number | undefined;
  const supportsFrames = typeof element.requestVideoFrameCallback === 'function';
  const listeners = new AbortController();

  const stopFrames = () => {
    if (frameRequest !== undefined) element.cancelVideoFrameCallback(frameRequest);
    frameRequest = undefined;
  };
  const snapshot = (sampleUs: number) => {
    if (!range || !previewFrameInRange(sampleUs / 1_000_000, range) || element.readyState < 2 || element.seeking) return;
    const size = events.frameSize?.(), width = element.videoWidth, height = element.videoHeight;
    if (!width || !height) return;
    const scale = Math.min(1, Math.min(1280, size?.width ?? 1280) / width, Math.min(1280, size?.height ?? 1280) / height);
    safeFrame ??= document.createElement('canvas');
    const targetWidth = Math.max(1, Math.round(width * scale)), targetHeight = Math.max(1, Math.round(height * scale));
    if (safeFrame.width !== targetWidth) safeFrame.width = targetWidth;
    if (safeFrame.height !== targetHeight) safeFrame.height = targetHeight;
    safeFrame.getContext('2d')!.drawImage(element, 0, 0, targetWidth, targetHeight);
    safeSampleUs = sampleUs; events.onFrame();
  };
  const snapshotSeek = () => {
    if (!range || element.seeking) return;
    // An accurate seek decodes the frame containing this requested sample. Its PTS may
    // precede the range start with a different source fps, matching FFmpeg's held frame.
    const atEnd = Number.isFinite(element.duration) && targetTime >= element.duration && element.currentTime >= element.duration - .005;
    snapshot(Math.round((atEnd ? targetTime : element.currentTime) * 1_000_000));
  };
  const watchFrames = () => {
    if (!active || document.hidden || !supportsFrames || frameRequest !== undefined) return;
    const generation = seekGeneration;
    frameRequest = element.requestVideoFrameCallback((_now, metadata) => {
      frameRequest = undefined;
      if (!active || generation !== seekGeneration) return;
      if (range) {
        if (!element.seeking) {
          if (previewFrameInRange(metadata.mediaTime, range)) snapshot(Math.round(metadata.mediaTime * 1_000_000));
          else if (Math.round(metadata.mediaTime * 1_000_000) >= range.endUs) {
            // Never let an independently running decoder paint into a removed interval.
            boundaryBlocked = true; element.pause();
          }
        }
      } else events.onFrame();
      if (playing && !boundaryBlocked || element.seeking) watchFrames();
    });
  };
  const synchronize = () => {
    if (!active) return;
    const shouldPlay = playing && !document.hidden;
    const duration = Number.isFinite(element.duration) ? Math.max(0, element.duration - .001) : Infinity;
    const position = Math.max(0, Math.min(targetTime, duration));
    if (range && boundaryBlocked && !forceSeek) { element.pause(); stopFrames(); return; }
    if (element.readyState >= 1 && !element.seeking) {
      const controlled = Boolean(range && !supportsFrames);
      const tolerance = forceSeek ? range ? .0000005 : .001 : shouldPlay && !controlled ? Math.max(.12, frameDuration * 2) : Math.min(.005, frameDuration / 3);
      if (Math.abs(element.currentTime - position) > tolerance) {
        stopFrames(); seekGeneration++; element.currentTime = position; watchFrames();
      }
      forceSeek = false;
    }
    // Browsers without decoded-frame callbacks use accurate EDL seeks, while legacy
    // videos retain their normal native playback path in both cases.
    const nativePlay = shouldPlay && !(range && !supportsFrames);
    if (!nativePlay) {
      element.pause();
      if (range) watchFrames(); else stopFrames();
      return;
    }
    if (element.paused && !element.ended && !playRequest && !playFailed && element.readyState >= 2) {
      playRequest = element.play().catch(error => {
        if (!active || !playing || document.hidden || (error instanceof DOMException && error.name === 'AbortError')) return;
        playFailed = true; events.onError('视频无法播放，请重新读取或检查文件格式');
      }).finally(() => { playRequest = undefined; });
    }
    watchFrames();
  };
  element.addEventListener('loadedmetadata', () => {
    if (element.preload === 'metadata' && targetTime === 0) element.currentTime = 0;
    synchronize();
  }, { signal: listeners.signal });
  element.addEventListener('loadeddata', () => {
    if (!ready) { ready = true; events.onReady(); }
    synchronize(); if (range) snapshotSeek(); else events.onFrame();
  }, { signal: listeners.signal });
  element.addEventListener('seeked', () => {
    if (range) snapshotSeek();
    synchronize(); events.onFrame();
  }, { signal: listeners.signal });
  element.addEventListener('error', () => events.onError('视频素材无法读取或解码'), { signal: listeners.signal });
  document.addEventListener('visibilitychange', synchronize, { signal: listeners.signal });

  return {
    synchronize(timeUs: number, nextPlaying: boolean, fps: number, nextDiscontinuityKey?: string, nextRange?: PreviewVideoRange) {
      if (playing !== nextPlaying) playFailed = false;
      const changed = nextDiscontinuityKey !== discontinuityKey || range?.startUs !== nextRange?.startUs || range?.endUs !== nextRange?.endUs;
      if (changed || timeUs / 1_000_000 < targetTime - .001) { boundaryBlocked = false; forceSeek = true; }
      discontinuityKey = nextDiscontinuityKey; range = nextRange;
      if (!range && safeFrame) { safeFrame.width = safeFrame.height = 0; safeFrame = undefined; safeSampleUs = undefined; }
      targetTime = Math.max(0, timeUs / 1_000_000); playing = nextPlaying; frameDuration = 1 / fps; synchronize();
    },
    frameForPaint(expectedRange?: PreviewVideoRange): CanvasImageSource | undefined {
      if (!expectedRange) return element;
      return safeFrame && safeSampleUs !== undefined && previewFrameInRange(safeSampleUs / 1_000_000, expectedRange) ? safeFrame : undefined;
    },
    dispose() {
      active = false; listeners.abort(); stopFrames(); element.pause(); element.removeAttribute('src'); element.load();
      if (safeFrame) safeFrame.width = safeFrame.height = 0;
      safeFrame = undefined;
    },
  };
}
