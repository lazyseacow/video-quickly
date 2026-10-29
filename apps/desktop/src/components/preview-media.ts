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

export function createPreviewVideoController(element: HTMLVideoElement, events: { onFrame: () => void; onReady: () => void; onError: (message: string) => void }) {
  let active = true;
  let ready = false;
  let targetTime = 0;
  let playing = false;
  let frameDuration = 1 / 30;
  let frameRequest: number | undefined;
  let playRequest: Promise<void> | undefined;
  let playFailed = false;
  const listeners = new AbortController();

  const stopFrames = () => {
    if (frameRequest !== undefined) element.cancelVideoFrameCallback(frameRequest);
    frameRequest = undefined;
  };
  const watchFrames = () => {
    if (!active || !playing || document.hidden || !('requestVideoFrameCallback' in element) || frameRequest !== undefined) return;
    frameRequest = element.requestVideoFrameCallback(() => {
      frameRequest = undefined;
      if (!active) return;
      events.onFrame();
      watchFrames();
    });
  };
  const synchronize = () => {
    if (!active) return;
    const shouldPlay = playing && !document.hidden;
    const duration = Number.isFinite(element.duration) ? Math.max(0, element.duration - .001) : Infinity;
    const position = Math.max(0, Math.min(targetTime, duration));
    // Finish a pending decoder seek before applying the latest scrub position.
    // Native playback advances itself; only correct material editor-clock drift.
    if (element.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - position) > (shouldPlay ? Math.max(.12, frameDuration * 2) : Math.min(.005, frameDuration / 3))) {
      element.currentTime = position;
    }
    if (!shouldPlay) {
      element.pause();
      stopFrames();
      return;
    }
    if (element.paused && !element.ended && !playRequest && !playFailed && element.readyState >= 2) {
      playRequest = element.play().catch(error => {
        if (!active || !playing || document.hidden || (error instanceof DOMException && error.name === 'AbortError')) return;
        playFailed = true;
        events.onError('视频无法播放，请重新读取或检查文件格式');
      }).finally(() => { playRequest = undefined; });
    }
    watchFrames();
  };
  element.addEventListener('loadedmetadata', () => {
    // Metadata preload can report dimensions without a drawable first frame.
    // A single seek requests that frame without playing thumbnail videos.
    if (element.preload === 'metadata' && targetTime === 0) element.currentTime = 0;
    synchronize();
  }, { signal: listeners.signal });
  element.addEventListener('loadeddata', () => {
    if (!ready) { ready = true; events.onReady(); }
    synchronize();
    events.onFrame();
  }, { signal: listeners.signal });
  element.addEventListener('seeked', () => {
    synchronize();
    events.onFrame();
  }, { signal: listeners.signal });
  element.addEventListener('error', () => events.onError('视频素材无法读取或解码'), { signal: listeners.signal });
  document.addEventListener('visibilitychange', synchronize, { signal: listeners.signal });

  return {
    synchronize(timeUs: number, nextPlaying: boolean, fps: number) {
      if (playing !== nextPlaying) playFailed = false;
      targetTime = Math.max(0, timeUs / 1_000_000);
      playing = nextPlaying;
      frameDuration = 1 / fps;
      synchronize();
    },
    dispose() {
      active = false;
      listeners.abort();
      stopFrames();
      element.pause();
      element.removeAttribute('src');
      element.load();
    },
  };
}
