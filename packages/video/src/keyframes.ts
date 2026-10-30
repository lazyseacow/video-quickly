import type { MotionKeyframe, Shot } from '@video-quickly/contracts';
import { resolveShotSpans, resolveShotTime, type ClipEditContext, type ClipTimingShot } from './clip-edits.js';

export interface MotionPose { panX: number; panY: number; zoom: number }
export function motionSceneTimeUs(shot: ClipTimingShot, context: ClipEditContext, localUs: number) { return resolveShotTime(shot, context, localUs).sceneUs; }
export function motionLocalTimeUs(shot: ClipTimingShot, context: ClipEditContext, sceneUs: number): number | undefined {
  const spans = resolveShotSpans(shot, context);
  for (const span of spans) {
    if (sceneUs >= span.sceneInUs && sceneUs < span.sceneInUs + span.durationUs) return span.outputStartUs + sceneUs - span.sceneInUs;
    if (span === spans.at(-1) && sceneUs === span.sceneInUs + span.durationUs) return shot.durationUs;
  }
}

function ease(frame: MotionKeyframe, progress: number): number {
  if (frame.easing === 'hold') return 0;
  if (frame.easing === 'linear') return progress;
  if (frame.easing === 'ease-in') return progress * progress;
  if (frame.easing === 'ease-out') return progress * (2 - progress);
  if (frame.easing !== 'cubic-bezier' || !frame.curve) return progress * progress * (3 - 2 * progress);
  const [x1, y1, x2, y2] = frame.curve;
  const bezier = (value: number, first: number, second: number) => 3 * (1 - value) ** 2 * value * first + 3 * (1 - value) * value ** 2 * second + value ** 3;
  // The authored x axis is time. Evaluating y(progress) directly would change the curve's timing.
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 32; iteration++) { const middle = (low + high) / 2; if (bezier(middle, x1, x2) < progress) low = middle; else high = middle; }
  return bezier((low + high) / 2, y1, y2);
}

export function sampleMotion(animation: Shot['animation'] | undefined, sceneUs: number, durationUs: number, defaultZoom = 1.04): MotionPose {
  const frames = animation?.keyframes;
  if (!frames?.length) {
    const t = Math.max(0, Math.min(1, sceneUs / Math.max(1, durationUs))), progress = t * t * (3 - 2 * t);
    return { panX: (animation?.panX ?? 0) * progress, panY: (animation?.panY ?? 0) * progress, zoom: 1 + ((animation?.zoom ?? defaultZoom) - 1) * progress };
  }
  const first = frames[0], last = frames.at(-1)!;
  if (sceneUs <= first.timeUs) return { panX: first.panX, panY: first.panY, zoom: first.zoom };
  if (sceneUs >= last.timeUs) return { panX: last.panX, panY: last.panY, zoom: last.zoom };
  let low = 0, high = frames.length - 1;
  while (high - low > 1) { const middle = (low + high) >>> 1; if (frames[middle].timeUs <= sceneUs) low = middle; else high = middle; }
  const start = frames[low], end = frames[high], progress = ease(start, (sceneUs - start.timeUs) / (end.timeUs - start.timeUs));
  return { panX: start.panX + (end.panX - start.panX) * progress, panY: start.panY + (end.panY - start.panY) * progress, zoom: start.zoom + (end.zoom - start.zoom) * progress };
}
