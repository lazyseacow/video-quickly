import { captionTrackSchema, type CaptionCue, type CaptionTrack, type Shot } from '@video-quickly/contracts';
import { mediaSourceInUs } from './audio.js';
import { clipEditPlan, clipEditSource, clipEditTotalUs, resolveShotSpans, resolveShotTime, sourceCaptionTrack, type ClipEditContext } from './clip-edits.js';

export type CaptionClip = Pick<Shot, 'durationUs' | 'narration'> & Partial<Pick<Shot, 'sourceInUs' | 'audioInUs' | 'sceneInUs' | 'sceneDurationUs' | 'captionTrack' | 'clipEdit'>>;
export type CaptionPages = (text: string) => string[][];

export function splitCaptionText(text: string): string[] {
  return text.trim().split(/(?<=[。！？；;])\s*|(?<=[.!?])\s+|\r?\n+/u).map(value => value.trim()).filter(Boolean);
}

/** Estimation is an editable starting point, with no claim of speech alignment. */
export function createEstimatedCaptionTrack(shot: CaptionClip, pages: CaptionPages = text => splitCaptionText(text).map(value => [value])): CaptionTrack {
  const durationUs = shot.sceneDurationUs ?? shot.durationUs;
  const blocks = pages(shot.narration).filter(lines => lines.some(line => line.trim()));
  const texts = blocks.length > durationUs ? [blocks.flat().join('\n')] : blocks.map(lines => lines.join('\n'));
  return {
    timeBase: 'scene', alignment: 'estimated', granularity: 'segment',
    cues: texts.map((text, index) => ({ id: `caption-${index + 1}`, startUs: Math.round(durationUs * index / texts.length), endUs: Math.round(durationUs * (index + 1) / texts.length), text })),
  };
}

/** Reading pages are a display estimate inside a real cue, never replacement ASR segments. */
function displayPages(cue: CaptionCue, pages: CaptionPages): CaptionCue[] {
  const blocks = pages(cue.text).filter(lines => lines.some(line => line.trim()));
  const weights = blocks.map(lines => Math.max(1, Array.from(lines.join('')).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let consumed = 0;
  return blocks.map((lines, index) => {
    const startUs = cue.startUs + (cue.endUs - cue.startUs) * consumed / totalWeight;
    consumed += weights[index];
    const endUs = cue.startUs + (cue.endUs - cue.startUs) * consumed / totalWeight;
    return { ...cue, id: JSON.stringify([cue.id, index]), startUs, endUs, text: lines.join('\n') };
  });
}

/** Source cues use media time; scene cues use the authored scene's independent clock. */
export function projectCaptionCues(shot: CaptionClip, timelineStartUs = 0, pages?: CaptionPages, context: ClipEditContext = {}): CaptionCue[] {
  const authored = sourceCaptionTrack(shot, context);
  if (shot.clipEdit) {
    const original = clipEditSource(shot, context)!.original;
    const track = authored ?? createEstimatedCaptionTrack({ ...shot, sceneDurationUs: original.sceneDurationUs ?? original.durationUs }, pages);
    const cues = authored && pages ? track.cues.flatMap(cue => displayPages(cue, pages)) : track.cues;
    const usedIds = new Set<string>();
    return resolveShotSpans(shot, context).flatMap(span => {
      const offsetUs = track.timeBase === 'source' ? span.audioInUs : track.timeBase === 'clip' ? span.planStartUs : span.sceneInUs;
      let lower = 0, upper = cues.length;
      while (lower < upper) { const middle = (lower + upper) >>> 1; if (cues[middle].endUs <= offsetUs) lower = middle + 1; else upper = middle; }
      if (!authored && lower === cues.length && cues.length) lower--;
      const visible: CaptionCue[] = [];
      for (let index = lower; index < cues.length && cues[index].startUs < offsetUs + span.durationUs; index++) {
        const cue = cues[index];
        const startUs = Math.max(offsetUs, cue.startUs);
        const endUs = Math.min(offsetUs + span.durationUs, !authored && index === cues.length - 1 ? Math.max(cue.endUs, offsetUs + span.durationUs) : cue.endUs);
        if (endUs <= startUs) continue;
        let id = cue.id;
        while (usedIds.has(id)) id = JSON.stringify([id, span.id, span.planStartUs]);
        usedIds.add(id);
        visible.push({ ...cue, id, startUs: timelineStartUs + span.outputStartUs + startUs - offsetUs, endUs: timelineStartUs + span.outputStartUs + endUs - offsetUs });
      }
      return visible;
    });
  }
  const track = authored ?? createEstimatedCaptionTrack(shot, pages);
  const offsetUs = track.timeBase === 'source' ? mediaSourceInUs(shot, 'audio') : track.timeBase === 'clip' ? 0 : shot.sceneInUs ?? 0;
  const clipEndUs = offsetUs + shot.durationUs;
  // Paginate before cropping so adjacent split clips share the original reading-page clock.
  const cues = shot.captionTrack && pages ? track.cues.filter(cue => cue.endUs > offsetUs && cue.startUs < clipEndUs).flatMap(cue => displayPages(cue, pages)) : track.cues;
  return cues.flatMap((cue, index) => {
    const startUs = Math.max(offsetUs, cue.startUs);
    // Legacy narration holds its final page when the authored sample scene is extended.
    const authoredEndUs = !shot.captionTrack && index === cues.length - 1 ? Math.max(cue.endUs, clipEndUs) : cue.endUs;
    const endUs = Math.min(clipEndUs, authoredEndUs);
    return endUs > startUs ? [{ ...cue, startUs: timelineStartUs + startUs - offsetUs, endUs: timelineStartUs + endUs - offsetUs }] : [];
  });
}

/** Intervals are half open, so a gap in aligned speech never displays an estimated caption. */
export function captionAtTime(shot: CaptionClip, localTimeUs: number, pages?: CaptionPages, context: ClipEditContext = {}): CaptionCue | undefined {
  let current = shot;
  const track = sourceCaptionTrack(shot, context);
  if (track) {
    const mapped = shot.clipEdit ? resolveShotTime(shot, context, localTimeUs) : undefined;
    const sourceUs = track.timeBase === 'source' ? mapped?.audioUs ?? localTimeUs + mediaSourceInUs(shot, 'audio') : track.timeBase === 'clip' ? localTimeUs + (shot.clipEdit?.inUs ?? 0) : mapped?.sceneUs ?? localTimeUs + (shot.sceneInUs ?? 0);
    const cue = track.cues.find(cue => sourceUs >= cue.startUs && sourceUs < cue.endUs);
    if (!cue) return undefined;
    // Measure only the active original cue during playback, rather than every word in a long ASR track.
    current = { ...shot, captionTrack: { ...track, cues: [cue] } };
  }
  return projectCaptionCues(current, 0, pages, context).find(cue => localTimeUs >= cue.startUs && localTimeUs < cue.endUs);
}

/** Replace only this clip's visible window; extending a crop can still reveal untouched source cues. */
export function replaceVisibleCaptionCues(shot: CaptionClip, track: CaptionTrack, localCues: readonly CaptionCue[], context: ClipEditContext = {}): CaptionTrack {
  captionTrackSchema.parse({ ...track, cues: localCues });
  if (localCues.some(cue => cue.endUs > shot.durationUs)) throw new RangeError('字幕时间须位于当前片段范围内。');
  if (shot.clipEdit && track.timeBase !== 'clip') {
    const plan = clipEditPlan(shot, context)!;
    const complete = { ...shot, durationUs: clipEditTotalUs(plan), captionTrack: track, clipEdit: { ...shot.clipEdit, inUs: 0 } };
    const projected: CaptionTrack = { ...track, timeBase: 'clip', alignment: 'manual', cues: projectCaptionCues(complete, 0, undefined, context) };
    return replaceVisibleCaptionCues(shot, projected, localCues, context);
  }
  const offsetUs = track.timeBase === 'source' ? mediaSourceInUs(shot, 'audio') : track.timeBase === 'clip' ? shot.clipEdit?.inUs ?? 0 : shot.sceneInUs ?? 0;
  const endUs = offsetUs + shot.durationUs;
  const ids = new Set([...track.cues, ...localCues].map(cue => cue.id));
  function fragmentId(id: string): string {
    let result = id;
    let suffix = 1;
    while (ids.has(result)) result = `${id}-${++suffix}`;
    ids.add(result);
    return result;
  }
  const retained = track.cues.flatMap(cue => {
    if (cue.endUs <= offsetUs || cue.startUs >= endUs) return [cue];
    const fragments: CaptionCue[] = [];
    if (cue.startUs < offsetUs) fragments.push({ ...cue, id: fragmentId(`${cue.id}-before`), endUs: offsetUs });
    if (cue.endUs > endUs) fragments.push({ ...cue, id: fragmentId(`${cue.id}-after`), startUs: endUs });
    return fragments;
  });
  const replacements = localCues.map(cue => ({ ...cue, startUs: offsetUs + cue.startUs, endUs: offsetUs + cue.endUs }));
  return captionTrackSchema.parse({ ...track, alignment: 'manual', cues: [...retained, ...replacements].sort((a, b) => a.startUs - b.startUs) });
}
