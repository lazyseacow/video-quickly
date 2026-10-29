import type { MusicClip, Shot } from '@video-quickly/contracts';
import { clipSourceOutUs, resolveShotTime, type ClipEditContext } from './clip-edits.js';

export type MediaSourceOffsets = Pick<Shot, 'sourceInUs' | 'audioInUs' | 'videoInUs'> & Partial<Pick<Shot, 'clipEdit' | 'durationUs'>>;
export interface SourceDurations { audioDurationUs?: number; videoDurationUs?: number }

export function mediaSourceInUs(shot: MediaSourceOffsets, kind: 'audio' | 'video', context: ClipEditContext = {}): number {
  if (shot.clipEdit) { const resolved = resolveShotTime({ ...shot, durationUs: shot.durationUs ?? 1 }, context, 0); return kind === 'audio' ? resolved.audioUs : resolved.videoUs; }
  return (kind === 'audio' ? shot.audioInUs : shot.videoInUs) ?? shot.sourceInUs ?? 0;
}

/** Translate each independently selected source tail back to the common clip-trim clock. */
export function commonSourceOutUs(shot: MediaSourceOffsets, durations: SourceDurations, context: ClipEditContext = {}): number | undefined {
  if (shot.clipEdit) return clipSourceOutUs({ ...shot, durationUs: shot.durationUs ?? 1 }, context, durations);
  const tails: number[] = [];
  if (durations.audioDurationUs !== undefined) tails.push(durations.audioDurationUs - mediaSourceInUs(shot, 'audio'));
  if (durations.videoDurationUs !== undefined) tails.push(durations.videoDurationUs - mediaSourceInUs(shot, 'video'));
  return tails.length ? (shot.sourceInUs ?? 0) + Math.max(...tails) : undefined;
}

export interface MusicPlayback { timeUs: number; gain: number; active: boolean }

/** BGM lives on project time and loops only the source tail after its chosen in point. */
export function musicPlaybackAtTime(clip: MusicClip, projectTimeUs: number, sourceDurationUs: number): MusicPlayback {
  const localUs = projectTimeUs - clip.startUs;
  const sourceLengthUs = sourceDurationUs - clip.sourceInUs;
  if (!Number.isFinite(localUs) || !Number.isFinite(sourceLengthUs) || sourceLengthUs <= 0 || localUs < 0 || localUs >= clip.durationUs || (!clip.loop && localUs >= sourceLengthUs)) return { timeUs: clip.sourceInUs, gain: 0, active: false };
  const fadeIn = clip.fadeInUs > 0 ? Math.min(1, localUs / clip.fadeInUs) : 1;
  const fadeOut = clip.fadeOutUs > 0 ? Math.min(1, (clip.durationUs - localUs) / clip.fadeOutUs) : 1;
  return { timeUs: clip.sourceInUs + (clip.loop ? localUs % sourceLengthUs : localUs), gain: 10 ** (clip.gainDb / 20) * fadeIn * fadeOut, active: true };
}
