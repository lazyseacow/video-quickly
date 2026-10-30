import type { AssetRecord } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { createPreviewVideoController, previewAssetKey } from './preview-media';

export interface ThumbnailRequest { asset: AssetRecord; timeUs: number; width: number; height: number }
export interface ThumbnailFrame { image: HTMLCanvasElement; width: number; height: number }
interface Pending<Frame> {
  key: string; input: ThumbnailRequest; controller: AbortController; users: Set<symbol>; started: boolean;
  promise: Promise<Frame>; resolve: (frame: Frame) => void; reject: (error: unknown) => void;
}
const aborted = () => new DOMException('缩略图读取已取消', 'AbortError');

export class ThumbnailCache<Frame extends { width: number; height: number }> {
  private readonly frames = new Map<string, Frame>();
  private readonly pending = new Map<string, Pending<Frame>>();
  private readonly queue: Pending<Frame>[] = [];
  private active = 0;
  private pixels = 0;
  constructor(private readonly decode: (input: ThumbnailRequest, signal: AbortSignal) => Promise<Frame>, private readonly limits = { concurrency: 2, frames: 48, pixels: 8_000_000 }) {}

  read(input: ThumbnailRequest, signal: AbortSignal): Promise<Frame> {
    if (signal.aborted) return Promise.reject(aborted());
    const key = JSON.stringify([previewAssetKey(input.asset), input.timeUs, input.width, input.height]);
    const cached = this.frames.get(key);
    if (cached) { this.frames.delete(key); this.frames.set(key, cached); return Promise.resolve(cached); }
    let entry = this.pending.get(key);
    if (!entry) {
      let complete!: (frame: Frame) => void, fail!: (error: unknown) => void;
      const promise = new Promise<Frame>((resolve, reject) => { complete = resolve; fail = reject; });
      entry = { key, input, promise, resolve: complete, reject: fail, controller: new AbortController(), users: new Set(), started: false };
      this.pending.set(key, entry); this.queue.push(entry);
    }
    const task = entry;
    const result = new Promise<Frame>((resolve, reject) => {
      const user = Symbol(); task.users.add(user);
      const cancel = () => {
        task.users.delete(user); reject(aborted());
        if (!task.users.size) {
          task.controller.abort();
          if (this.pending.get(key) === task) this.pending.delete(key);
          if (!task.started) {
            const index = this.queue.indexOf(task); if (index !== -1) this.queue.splice(index, 1);
            task.reject(aborted());
          }
        }
      };
      signal.addEventListener('abort', cancel, { once: true });
      const cleanup = () => { signal.removeEventListener('abort', cancel); task.users.delete(user); };
      task.promise.then(frame => { cleanup(); if (!signal.aborted) resolve(frame); }, error => { cleanup(); reject(error); });
    });
    this.pump(); return result;
  }

  private pump() {
    while (this.active < this.limits.concurrency && this.queue.length) {
      const task = this.queue.shift(); if (!task) return;
      this.active++; task.started = true;
      void this.run(task);
    }
  }
  private async run(task: Pending<Frame>) {
    try {
      const frame = await this.decode(task.input, task.controller.signal);
      if (task.controller.signal.aborted) throw aborted();
      const pixels = frame.width * frame.height;
      if (pixels <= this.limits.pixels) {
        this.frames.set(task.key, frame); this.pixels += pixels;
        for (const [key, oldest] of this.frames) {
          if (this.frames.size <= this.limits.frames && this.pixels <= this.limits.pixels) break;
          this.frames.delete(key); this.pixels -= oldest.width * oldest.height;
        }
      }
      task.resolve(frame);
    } catch (error) { task.reject(error); }
    finally {
      if (this.pending.get(task.key) === task) this.pending.delete(task.key);
      this.active--; this.pump();
    }
  }
}

function capture(input: ThumbnailRequest, signal: AbortSignal): Promise<ThumbnailFrame> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    let settled = false, timeout: ReturnType<typeof setTimeout> | undefined;
    let controller: ReturnType<typeof createPreviewVideoController> | undefined;
    const range = { startUs: input.timeUs, endUs: input.timeUs + 1 };
    const cleanup = () => { if (timeout !== undefined) clearTimeout(timeout); signal.removeEventListener('abort', cancel); controller?.dispose(); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const cancel = () => fail(aborted());
    const ready = () => {
      if (settled || video.seeking || video.readyState < 2) return;
      const source = controller?.frameForPaint(range); if (!source) return;
      const scale = Math.min(1, input.width / video.videoWidth, input.height / video.videoHeight);
      const image = document.createElement('canvas'); image.width = Math.max(1, Math.round(video.videoWidth * scale)); image.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = image.getContext('2d'); if (!context) { fail(new Error('无法读取视频缩略图')); return; }
      try { context.drawImage(source, 0, 0, image.width, image.height); }
      catch (error) { fail(error); return; }
      settled = true; cleanup(); resolve({ image, width: image.width, height: image.height });
    };
    controller = createPreviewVideoController(video, { onReady: ready, onFrame: ready, onError: message => fail(new Error(message)), frameSize: () => input });
    // A one-microsecond range requests an accurate source sample, including a held tail frame.
    controller.synchronize(input.timeUs, false, 30, 'thumbnail', range);
    signal.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => fail(new Error('视频缩略图读取超时')), 8_000);
    void getAssetUrl(input.asset.path).then(url => { if (!settled) { video.src = url; video.load(); } }).catch(fail);
  });
}

export const videoThumbnails = new ThumbnailCache(capture);
