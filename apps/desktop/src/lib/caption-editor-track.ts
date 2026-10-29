import type { CaptionTrack, Shot } from '@video-quickly/contracts';
import { createEstimatedCaptionTrack, projectCaptionCues, replaceVisibleCaptionCues, sourceCaptionTrack, type ClipEditContext } from '@video-quickly/video';

export function captionTrackForEditor(shot: Shot, context: ClipEditContext = {}): CaptionTrack {
  return sourceCaptionTrack(shot, context) ?? createEstimatedCaptionTrack(shot);
}

export function localCaptionTrack(shot: Shot, track: CaptionTrack, context: ClipEditContext = {}): CaptionTrack {
  return { ...track, cues: projectCaptionCues({ ...shot, captionTrack: track }, 0, undefined, context) };
}

/** Untouched recognition retains its original provenance; manual edits use the complete plan clock. */
export function commitCaptionEditorTrack(shot: Shot, fullTrack: CaptionTrack, draft: CaptionTrack, context: ClipEditContext = {}, captionsOff = false): CaptionTrack {
  if (captionsOff) return { ...draft, timeBase: shot.clipEdit ? 'clip' : draft.timeBase, alignment: 'manual', cues: [] };
  if (JSON.stringify(draft) === JSON.stringify(localCaptionTrack(shot, fullTrack, context))) return fullTrack;
  return replaceVisibleCaptionCues(shot, { ...fullTrack, ...draft, cues: fullTrack.cues }, draft.cues.map(cue => ({ ...cue, text: cue.text.trim() })), context);
}
