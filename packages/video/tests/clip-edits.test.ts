import { describe, expect, it } from 'vitest';
import { captionTrackSchema, shotSchema, timeAtFrame, type CaptionTrack, type ClipEditPlan, type Shot } from '@video-quickly/contracts';
import { clipEditPlan, clipEditSource, clipEditTotalUs, clipSourceOutUs, deleteShotRanges, replaceShotMedia, resolveShotSpans, resolveShotTime, restoreShotRanges, sourceCaptionTrack, type ClipEditContext, type ClipEditIdFactory } from '../src/clip-edits.js';
import { captionAtTime, projectCaptionCues, replaceVisibleCaptionCues } from '../src/captions.js';
import { canSplitShot, minimumSourceInUs, splitShot, trimShot, trimShotInContext } from '../src/editing.js';
import { commonSourceOutUs, mediaSourceInUs } from '../src/audio.js';
import { createSrt, createSubtitleCues } from '../src/index.js';

const second = 1_000_000, rate = { numerator: 30, denominator: 1 };
const assets = ['image', 'audio', 'video', 'new-audio', 'new-video'].map(id => ({ id, sha256: 'a'.repeat(64) }));
function factory(): ClipEditIdFactory { let count = 0; return kind => `${kind}-${++count}`; }
function fixture(captionBase: 'source' | 'scene' = 'source') {
  const captionTrack: CaptionTrack = { timeBase: captionBase, alignment: captionBase === 'source' ? 'speech' : 'manual', granularity: 'word',
    ...(captionBase === 'source' ? { sourceAssetId: 'audio', sourceSha256: assets[1].sha256 } : {}),
    cues: Array.from({ length: 8 }, (_, index) => ({ id: `word-${index}`, text: `词${index}`, startUs: (index + (captionBase === 'source' ? 1 : 3)) * second, endUs: (index + (captionBase === 'source' ? 2 : 4)) * second })) };
  const shot = shotSchema.parse({ id: 'shot', title: '原镜头', narration: '原旁白不按字数伪造时间', visualPrompt: '原要求', durationUs: 8 * second,
    sourceInUs: 5 * second, audioInUs: second, videoInUs: 2 * second, sceneInUs: 3 * second, sceneDurationUs: 12 * second, sceneIndex: 3,
    assetId: 'image', audioAssetId: 'audio', videoAssetId: 'video', captionTrack });
  return { shots: [shot], clipEditSources: [], clipEditPlans: [] } as { shots: Shot[] } & ClipEditContext;
}
function cut(content = fixture(), id = factory()) {
  return deleteShotRanges(content, 'shot', [{ startUs: 2 * second, endUs: 4 * second }], rate, assets, id);
}

describe('one logical shot with fixed source-local edit spans', () => {
  it('resolves legacy shots without a registry and rejects dangling edited references', () => {
    const shot = fixture().shots[0];
    expect(resolveShotTime(shot, {}, second)).toMatchObject({ originUs: second, sourceUs: 6 * second, audioUs: 2 * second, videoUs: 3 * second, sceneUs: 4 * second });
    expect(() => resolveShotSpans({ ...shot, clipEdit: { planId: 'missing', inUs: 0, restoreInUs: 0, restoreDurationUs: shot.durationUs } }, {})).toThrow('计划缺失');
  });

  it('captures one original track and advances all four clocks across an internal deletion', () => {
    const original = fixture(), content = cut(original), shot = content.shots[0], source = clipEditSource(shot, content)!;
    expect(shot.durationUs).toBe(6 * second); expect(shot.captionTrack).toBeUndefined();
    expect(source.original.captionTrack).toEqual(original.shots[0].captionTrack); expect(source.assetHashes).toHaveLength(3);
    expect(resolveShotSpans(shot, content).map(span => [span.outputStartUs, span.durationUs, span.originInUs, span.audioInUs, span.videoInUs, span.sceneInUs])).toEqual([
      [0, 2 * second, 0, second, 2 * second, 3 * second],
      [2 * second, 4 * second, 4 * second, 5 * second, 6 * second, 7 * second],
    ]);
    const before = resolveShotTime(shot, content, 2 * second - 1), after = resolveShotTime(shot, content, 2 * second);
    expect(after.originUs).toBe(4 * second); expect(after.audioUs).toBe(5 * second); expect(after.discontinuityKey).not.toBe(before.discontinuityKey);
    expect(original.shots[0].durationUs).toBe(8 * second); expect(original.clipEditPlans).toEqual([]);
  });

  it('flattens repeated deletions without cloning a large original caption track into spans or shots', () => {
    const id = factory(), original = fixture();
    original.shots[0].captionTrack = captionTrackSchema.parse({ ...original.shots[0].captionTrack!, cues: Array.from({ length: 10_000 }, (_, index) => ({ id: `cue-${index}`, text: '词', startUs: index * 800, endUs: index * 800 + 799 })) });
    const first = cut(original, id), next = deleteShotRanges(first, 'shot', [{ startUs: second, endUs: 2 * second }], rate, assets, id);
    expect(next.clipEditSources).toBe(first.clipEditSources); expect(next.clipEditSources).toHaveLength(1);
    expect(sourceCaptionTrack(next.shots[0], next)?.cues).toHaveLength(10_000);
    expect(next.shots[0].captionTrack).toBeUndefined(); expect(resolveShotSpans(next.shots[0], next).map(span => [span.originInUs, span.durationUs])).toEqual([[0, second], [4 * second, 4 * second]]);
    expect(Object.keys(clipEditPlan(next.shots[0], next)!.spans[0])).not.toContain('captionTrack');
  });

  it('merges overlapping ranges, permits a single-frame internal island, and refuses a short logical shot', () => {
    const frame = timeAtFrame(1, rate), id = factory();
    const content = deleteShotRanges(fixture(), 'shot', [{ startUs: frame, endUs: second }, { startUs: second / 2, endUs: 2 * second }], rate, assets, id);
    expect(resolveShotSpans(content.shots[0], content)[0].durationUs).toBe(frame);
    expect(() => deleteShotRanges(fixture(), 'shot', [{ startUs: 0, endUs: 7.8 * second }], rate, assets, id)).toThrow('0.5 秒');
    expect(() => deleteShotRanges(fixture(), 'shot', [{ startUs: -1, endUs: second }], rate, assets, id)).toThrow('区间');
    expect(() => deleteShotRanges({ ...fixture(), shots: [{ ...fixture().shots[0], locked: true }] }, 'shot', [{ startUs: 0, endUs: second }], rate, assets, id)).toThrow('解锁');
  });

  it('partitions original restoration windows when splitting at a deleted boundary', () => {
    const content = cut(), [left, right] = splitShot(content.shots[0], 2 * second, rate, 'right', content);
    expect(left.clipEdit).toMatchObject({ inUs: 0, restoreInUs: 0, restoreDurationUs: 4 * second });
    expect(right.clipEdit).toMatchObject({ inUs: 2 * second, restoreInUs: 4 * second, restoreDurationUs: 4 * second });
    const splitContent = { ...content, shots: [left, right] };
    const restoredLeft = restoreShotRanges(splitContent, left.id), restoredBoth = restoreShotRanges(restoredLeft, right.id);
    expect(restoredBoth.shots.map(shot => [shot.durationUs, shot.audioInUs, shot.sceneInUs])).toEqual([[4 * second, second, 3 * second], [4 * second, 5 * second, 7 * second]]);
    expect(restoredBoth.shots.every(shot => !shot.clipEdit)).toBe(true);
  });

  it('retains a deleted head in the original restoration window until the trim boundary is actually moved', () => {
    const content = deleteShotRanges(fixture(), 'shot', [{ startUs: 0, endUs: second }], rate, assets, factory());
    const sameHead = trimShot(content.shots[0], { inUs: 0, outUs: 6 * second }, rate, undefined, content);
    expect(sameHead.clipEdit).toMatchObject({ restoreInUs: 0, restoreDurationUs: 7 * second });
    const trimmed = trimShot(content.shots[0], { inUs: second, outUs: 6 * second }, rate, undefined, content);
    expect(trimmed.clipEdit).toMatchObject({ restoreInUs: 2 * second, restoreDurationUs: 5 * second });
    const restored = restoreShotRanges({ ...content, shots: [trimmed] }, 'shot').shots[0];
    expect(restored.durationUs).toBe(5 * second); expect(restored.audioInUs).toBe(3 * second);
  });

  it('extends a private plan tail while preserving deleted gaps, siblings and real source bounds', () => {
    const id = factory(), content = cut(fixture(), id), [left, right] = splitShot(content.shots[0], 2 * second, rate, 'right', content);
    const splitContent = { ...content, shots: [left, right] }, existing = clipEditPlan(right, content)!;
    const extended = trimShotInContext(splitContent, 'right', { inUs: 2 * second, outUs: 7 * second }, rate, 8 * second, id);
    expect(extended.shots[0]).toBe(left); expect(clipEditPlan(extended.shots[1], extended)!.id).not.toBe(existing.id);
    expect(resolveShotSpans(extended.shots[1], extended).map(span => [span.originInUs, span.durationUs])).toEqual([[4 * second, 4 * second], [8 * second, second]]);
    expect(clipEditTotalUs(existing)).toBe(6 * second);
    expect(() => trimShotInContext(content, 'shot', { inUs: 0, outUs: 8 * second + 1 }, rate, 8 * second, id)).toThrow('真实时长');
  });

  it('uses the longer independent source tail and supports a changed frame grid without rewriting cuts', () => {
    const content = cut(), shot = content.shots[0], before = JSON.stringify(content.clipEditPlans);
    expect(clipSourceOutUs(shot, content, { audioDurationUs: 11 * second, videoDurationUs: 10 * second })).toBe(8 * second);
    expect(commonSourceOutUs(shot, { audioDurationUs: 11 * second, videoDurationUs: 10 * second }, content)).toBe(8 * second);
    expect(mediaSourceInUs(shot, 'audio', content)).toBe(second); expect(minimumSourceInUs(shot)).toBe(0);
    const newRate = { numerator: 24, denominator: 1 }, splitAt = timeAtFrame(37, newRate);
    expect(canSplitShot(shot, splitAt, newRate)).toBe(true);
    const parts = splitShot(shot, splitAt, newRate, 'right', content);
    expect(resolveShotTime(parts[1], content, 0)).toMatchObject({ audioUs: second + splitAt });
    expect(parts[0].durationUs + parts[1].durationUs).toBe(shot.durationUs); expect(JSON.stringify(content.clipEditPlans)).toBe(before);
  });

  it('replaces only one channel and preserves its independent absolute clock through a second deletion', () => {
    const id = factory(), content = cut(fixture(), id), next = replaceShotMedia(content, 'shot', 'audio', assets[3], id);
    expect(resolveShotSpans(next.shots[0], next).map(span => [span.audioInUs, span.videoInUs])).toEqual([[0, 2 * second], [2 * second, 6 * second]]);
    const twice = deleteShotRanges(next, 'shot', [{ startUs: second, endUs: 2 * second }], rate, assets, id);
    expect(resolveShotSpans(twice.shots[0], twice).map(span => [span.audioInUs, span.videoInUs])).toEqual([[0, 2 * second], [2 * second, 6 * second]]);
    const video = replaceShotMedia(twice, 'shot', 'video', assets[4], id);
    expect(resolveShotSpans(video.shots[0], video).map(span => [span.audioInUs, span.videoInUs])).toEqual([[0, 0], [2 * second, second]]);
    expect(replaceShotMedia(video, 'shot', 'video', assets[4], id)).toBe(video);
    const restored = restoreShotRanges(video, 'shot').shots[0];
    expect(restored).toMatchObject({ audioAssetId: 'audio', videoAssetId: 'video', durationUs: 8 * second, audioInUs: second, videoInUs: 2 * second });
    expect(restored.captionTrack).toEqual(fixture().shots[0].captionTrack);
  });

  it.each(['source', 'scene'] as const)('projects %s captions through the exact same skipped intervals', base => {
    const content = cut(fixture(base)), shot = content.shots[0];
    expect(projectCaptionCues(shot, 10 * second, undefined, content).map(cue => [cue.text, cue.startUs, cue.endUs])).toEqual([0, 1, 4, 5, 6, 7].map((word, index) => [`词${word}`, (10 + index) * second, (11 + index) * second]));
    expect(captionAtTime(shot, 2 * second, undefined, content)?.text).toBe('词4');
    const srt = createSrt([shot], content); expect(srt).toContain('词4'); expect(srt).not.toContain('词2'); expect(srt).not.toContain('词3');
  });

  it('edits captions on plan time, preserves hidden portions after a trim and maps the override through another cut', () => {
    const id = factory(), content = cut(fixture(), id), shot = trimShot(content.shots[0], { inUs: second, outUs: 5 * second }, rate, undefined, content);
    const track = replaceVisibleCaptionCues(shot, sourceCaptionTrack(shot, content)!, [{ id: 'manual', text: '人工正文', startUs: 0, endUs: second }], content);
    expect(track.timeBase).toBe('clip'); expect(track.alignment).toBe('manual');
    expect(track.cues).toEqual(expect.arrayContaining([expect.objectContaining({ text: '词0', startUs: 0, endUs: second }), expect.objectContaining({ text: '词7', startUs: 5 * second, endUs: 6 * second })]));
    const local = { ...shot, captionTrack: track }, next = deleteShotRanges({ ...content, shots: [local] }, 'shot', [{ startUs: second, endUs: 2 * second }], rate, assets, id);
    expect(projectCaptionCues(next.shots[0], 0, undefined, next)[0]).toMatchObject({ text: '人工正文', startUs: 0, endUs: second });
    expect(captionTrackSchema.safeParse(sourceCaptionTrack(next.shots[0], next)).success).toBe(true);
  });

  it('does not create word timings from plain narration and makes duplicate projected cue identities unique', () => {
    const original = fixture(); original.shots[0].captionTrack = { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'one', text: '整句不按字拆成假词', startUs: 3 * second, endUs: 11 * second }] };
    const content = cut(original), cues = projectCaptionCues(content.shots[0], 0, undefined, content);
    expect(cues).toHaveLength(2); expect(new Set(cues.map(cue => cue.id)).size).toBe(2);
    expect(captionTrackSchema.safeParse({ timeBase: 'clip', alignment: 'manual', cues }).success).toBe(true);
    expect(createSubtitleCues(content.shots, text => [[text]], content).every(cue => cue.lines[0] === '整句不按字拆成假词')).toBe(true);
  });

  it('restores a split window when its captured manual captions originally used local clip time', () => {
    const original = fixture(); original.shots[0].captionTrack = { timeBase: 'clip', alignment: 'manual', cues: Array.from({ length: 8 }, (_, index) => ({ id: `local-${index}`, text: `原句${index}`, startUs: index * second, endUs: (index + 1) * second })) };
    const content = deleteShotRanges(original, 'shot', [{ startUs: 0, endUs: second }], rate, assets, factory());
    const parts = splitShot(content.shots[0], 2 * second, rate, 'right', content);
    const restored = restoreShotRanges({ ...content, shots: parts }, 'right').shots[1];
    expect(restored.clipEdit).toBeUndefined();
    expect(projectCaptionCues(restored)[0]).toMatchObject({ text: '原句3', startUs: 0, endUs: second });
  });
});
