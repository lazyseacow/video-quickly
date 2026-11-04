import { timeAtFrame, type FrameRate, type Shot } from '@video-quickly/contracts';
import { createRenderSchedule, type RenderClipSchedule } from './render-schedule.js';

export const TRANSITION_DURATION_US = 200_000;
export const FFMPEG_TRANSITIONS = { fade: 'fade', wipe: 'wipeleft' } as const;
export type TransitionKind = Shot['animation']['transition'];
export interface TransitionClip extends RenderClipSchedule { transition: TransitionKind; padFrames: number }
export interface TransitionTimeline { rate: FrameRate; clips: TransitionClip[]; totalFrames: number; durationUs: number }
export interface TransitionSample {
  frame: number; timeUs: number; shotIndex: number; localTimeUs: number;
  outgoing?: { shotIndex: number; localTimeUs: number };
  effect?: { kind: 'fade' | 'wipe'; progress: number; outgoingProgress: number; startUs: number; durationUs: number };
}

/** Match tpad's av_rescale_q(stop_duration, frame_rate, AV_TIME_BASE): nearest frame, including zero at 1–2 fps. */
export function transitionPaddingFrames(rate: FrameRate): number {
  return Math.round(TRANSITION_DURATION_US * rate.numerator / (1_000_000 * rate.denominator));
}

/** A zero-frame shot owns no picture sample; its audio and caption time remain on the authored timeline. */
export function createTransitionTimeline(shots: readonly Pick<Shot, 'durationUs' | 'animation'>[], rate: FrameRate): TransitionTimeline {
  const schedule = createRenderSchedule(shots, rate), padding = transitionPaddingFrames(rate);
  const clips = schedule.filter(clip => clip.frameCount > 0).map(clip => ({ ...clip, transition: shots[clip.index].animation.transition, padFrames: 0 }));
  clips.forEach((clip, index) => { if (clips[index + 1] && clips[index + 1].transition !== 'cut') clip.padFrames = padding; });
  const totalFrames = schedule.at(-1)?.endFrame ?? 0;
  return { rate: { ...rate }, clips, totalFrames, durationUs: timeAtFrame(totalFrames, rate) };
}

/** FFmpeg's duration parser truncates decimal seconds to six places for the xfade offset. */
function offsetTimeUs(frame: number, rate: FrameRate): number {
  const [seconds, fraction = ''] = String(frame * rate.denominator / rate.numerator).split('.');
  return Number(seconds) * 1_000_000 + Number(fraction.slice(0, 6).padEnd(6, '0'));
}

/** The preview holds the preceding rendered sample until the next global frame, including fractional fps boundaries. */
export function sampleTransition(timeline: TransitionTimeline, timeUs: number): TransitionSample | undefined {
  if (!Number.isFinite(timeUs)) throw new RangeError('预览时间须为有限数值。');
  if (!timeline.totalFrames || !timeline.clips.length) return undefined;
  const { rate, clips } = timeline;
  let frame = Math.max(0, Math.min(timeline.totalFrames - 1, Math.floor(timeUs * rate.numerator / (1_000_000 * rate.denominator))));
  while (frame > 0 && timeAtFrame(frame, rate) > timeUs) frame--;
  while (frame < timeline.totalFrames - 1 && timeAtFrame(frame + 1, rate) <= timeUs) frame++;
  const index = clips.findIndex(clip => frame < clip.endFrame), clip = clips[index];
  const sample: TransitionSample = { frame, timeUs: timeAtFrame(frame, rate), shotIndex: clip.index, localTimeUs: timeAtFrame(frame, rate) - clip.startUs };
  const previous = clips[index - 1], elapsedFrames = frame - clip.firstFrame;
  if (clip.transition === 'cut' || !previous || elapsedFrames >= previous.padFrames) return sample;
  const startUs = offsetTimeUs(clip.firstFrame, rate);
  // The first input's tpad advances clones by a rounded tick. Later joins have their global AVTB clock normalized.
  const pts = index === 1 ? startUs + elapsedFrames * Math.round(1_000_000 * rate.denominator / rate.numerator) : Math.trunc(frame * 1_000_000 * rate.denominator / rate.numerator);
  // xfade uses float32 arithmetic and supplies the outgoing weight to fade/wipeleft.
  const outgoingProgress = Math.min(1, Math.max(0, Math.fround(1 - Math.fround(Math.fround(pts - startUs) / TRANSITION_DURATION_US))));
  sample.outgoing = { shotIndex: previous.index, localTimeUs: timeAtFrame(previous.endFrame - 1, rate) - previous.startUs };
  sample.effect = { kind: clip.transition, progress: Math.fround(1 - outgoingProgress), outgoingProgress, startUs, durationUs: TRANSITION_DURATION_US };
  return sample;
}

/** FFmpeg wipeleft reveals the incoming picture from the right; the boundary column still belongs to the outgoing frame. */
export function wipeLeftIncomingStartX(width: number, outgoingProgress: number): number {
  return Math.min(width, Math.max(0, Math.trunc(Math.fround(width * outgoingProgress)) + 1));
}
