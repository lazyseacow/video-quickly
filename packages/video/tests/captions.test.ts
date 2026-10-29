import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { captionTrackSchema, DEFAULT_VIDEO_PROFILE, shotSchema, type CaptionTrack } from '@video-quickly/contracts';
import { captionAtTime, createEstimatedCaptionTrack, createSrt, createTimedSrt, drawSceneFrame, projectCaptionCues, replaceVisibleCaptionCues, splitCaptionText, type SceneFrame } from '../src/index.js';
import { reorderShots, splitShot, trimShot } from '../src/editing.js';

const rate = { numerator: 30, denominator: 1 };
const track = (): CaptionTrack => captionTrackSchema.parse({ timeBase: 'source', alignment: 'speech', sourceAssetId: 'audio', sourceSha256: 'source-hash', modelId: 'asr', granularity: 'segment', cues: [
  { id: 'early', startUs: 0, endUs: 1_000_000, text: '第一句' },
  { id: 'middle', startUs: 1_500_000, endUs: 3_000_000, text: '识别到的第二句' },
  { id: 'late', startUs: 3_500_000, endUs: 4_000_000, text: '最后一句' },
] });
const shot = () => shotSchema.parse({ id: 'shot', title: '真实字幕', narration: '旧旁白不能覆盖识别结果。', visualPrompt: '', durationUs: 4_000_000, captionTrack: track() });

describe('source and scene caption clocks', () => {
  it('projects only the visible source interval and preserves speech gaps and endpoint boundaries', () => {
    const clip = { ...shot(), sourceInUs: 2_000_000, sceneInUs: 500_000, durationUs: 1_500_000 };
    expect(projectCaptionCues(clip, 10_000_000)).toEqual([{ id: 'middle', startUs: 10_000_000, endUs: 11_000_000, text: '识别到的第二句' }]);
    expect(captionAtTime(clip, 999_999)?.id).toBe('middle');
    expect(captionAtTime(clip, 1_000_000)).toBeUndefined();
    expect(captionAtTime(clip, -1)).toBeUndefined();
    expect(track().cues[1].startUs).toBe(1_500_000);
    const authored = { ...clip, captionTrack: { ...track(), timeBase: 'scene' as const, alignment: 'manual' as const } };
    expect(projectCaptionCues(authored).map(cue => [cue.id, cue.startUs, cue.endUs])).toEqual([['early', 0, 500_000], ['middle', 1_000_000, 1_500_000]]);
  });

  it('uses the independent audio clock for speech projection, continuation and manual edits', () => {
    const replaced = { ...shot(), sourceInUs: 2_000_000, audioInUs: 0, videoInUs: 3_000_000 };
    expect(captionAtTime(replaced, 200_000)?.id).toBe('early');
    const [left, right] = splitShot(replaced, 2_000_000, rate, 'right');
    expect(createSrt([left, right])).toBe(createSrt([replaced]));
    const updated = replaceVisibleCaptionCues({ ...replaced, durationUs: 500_000 }, track(), [{ id: 'early', startUs: 0, endUs: 500_000, text: '新配音开头' }]);
    expect(updated.cues[0]).toMatchObject({ startUs: 0, endUs: 500_000, text: '新配音开头' });
    expect(updated.cues.at(-1)).toEqual(track().cues.at(-1));
    expect(projectCaptionCues({ ...replaced, captionTrack: updated })[0].text).toBe('新配音开头');
  });

  it('retains original cues through split, crop, extension and reordering', () => {
    const original = shot();
    const [left, right] = splitShot(original, 2_000_000, rate, 'right');
    expect(left.captionTrack).toBe(original.captionTrack); expect(right.captionTrack).toBe(original.captionTrack);
    expect(createSrt([left, right])).toBe(createSrt([original]));
    expect(createTimedSrt([left, right], text => [[text]])).toBe(createSrt([original]));
    const cropped = trimShot(original, { inUs: 2_000_000, outUs: 3_500_000 }, rate);
    const restored = trimShot(cropped, { inUs: 0, outUs: 4_000_000 }, rate);
    expect(createSrt([restored])).toBe(createSrt([original]));
    const moved = reorderShots([left, right], 'right', 0);
    expect(projectCaptionCues(moved[0]).map(cue => [cue.id, cue.startUs])).toEqual([['middle', 0], ['late', 1_500_000]]);
    expect(original.captionTrack?.cues).toEqual(track().cues);
  });

  it('labels sentence estimates and allows an empty manual track to disable automatic narration', () => {
    expect(splitCaptionText('第一句。第二句！\nThird sentence. Last sentence.')).toEqual(['第一句。', '第二句！', 'Third sentence.', 'Last sentence.']);
    const legacy = { ...shot(), captionTrack: undefined, narration: '第一句。第二句。', sceneDurationUs: 4_000_000, sceneInUs: 2_000_000, durationUs: 1_000_000 };
    const estimated = createEstimatedCaptionTrack(legacy);
    expect(estimated).toMatchObject({ alignment: 'estimated', timeBase: 'scene', cues: [{ startUs: 0, endUs: 2_000_000 }, { startUs: 2_000_000, endUs: 4_000_000 }] });
    expect(captionTrackSchema.safeParse(estimated).success).toBe(true);
    expect(projectCaptionCues(legacy)[0]).toMatchObject({ startUs: 0, endUs: 1_000_000, text: '第二句。' });
    const muted = { ...legacy, captionTrack: { timeBase: 'scene' as const, alignment: 'manual' as const, cues: [] } };
    expect(projectCaptionCues(muted)).toEqual([]); expect(createSrt([muted])).toBe('');
    expect(createEstimatedCaptionTrack({ durationUs: 1_000_000, narration: '' }).cues).toEqual([]);
  });

  it('keeps provided cue times when its wrapped text fits a single display page', () => {
    const srt = createTimedSrt([shot()], text => [[text.slice(0, 2), text.slice(2)]]);
    expect(srt.match(/ --> /g)).toHaveLength(3);
    expect(srt).toContain('00:00:01,500 --> 00:00:03,000');
    expect(srt).not.toContain('旧旁白');
  });

  it('weights reading pages inside the original cue before source or scene projection without changing ASR segments', () => {
    const pages = (text: string) => [[text.slice(0, 1)], [text.slice(1)]];
    for (const timeBase of ['source', 'scene'] as const) {
      const captionTrack: CaptionTrack = { ...track(), timeBase, alignment: timeBase === 'source' ? 'speech' : 'manual', cues: [{ id: 'original', startUs: 500_000, endUs: 4_500_000, text: 'ABCD' }] };
      const original = { ...shot(), durationUs: 5_000_000, sourceInUs: 0, sceneInUs: 0, captionTrack };
      const before = structuredClone(captionTrack);
      const projected = projectCaptionCues(original, 0, pages);
      expect(projected.map(cue => [cue.startUs, cue.endUs, cue.text])).toEqual([[500_000, 1_500_000, 'A'], [1_500_000, 4_500_000, 'BCD']]);
      expect(captionAtTime(original, 499_999, pages)).toBeUndefined();
      expect(captionAtTime(original, 1_499_999, pages)?.text).toBe('A');
      expect(captionAtTime(original, 1_500_000, pages)?.text).toBe('BCD');
      expect(captionAtTime(original, 4_500_000, pages)).toBeUndefined();
      const [left, right] = splitShot(original, 2_000_000, rate, 'right');
      expect(createTimedSrt([left, right], pages)).toBe(createTimedSrt([original], pages));
      expect(projectCaptionCues(right, 0, pages).map(cue => [cue.startUs, cue.endUs, cue.text])).toEqual([[0, 2_500_000, 'BCD']]);
      expect(projectCaptionCues(trimShot(original, { inUs: 2_000_000, outUs: 4_000_000 }, rate), 0, pages).map(cue => [cue.startUs, cue.endUs, cue.text])).toEqual([[0, 2_000_000, 'BCD']]);
      expect(projectCaptionCues(original)).toEqual(before.cues);
      expect(original.captionTrack).toEqual(before);
    }
  });

  it('measures only the active original ASR segment while playing a long word track', () => {
    const captions = { ...track(), cues: Array.from({ length: 3000 }, (_, index) => ({ id: `word-${index}`, text: String(index), startUs: index * 100_000, endUs: (index + 1) * 100_000 })) };
    const measured: string[] = [];
    expect(captionAtTime({ ...shot(), durationUs: 300_000_000, captionTrack: captions }, 299_950_000, text => { measured.push(text); return [[text]]; })?.text).toBe('2999');
    expect(measured).toEqual(['2999']);
  });

  it('replaces visible cues while retaining hidden material and fresh identities for boundary fragments', () => {
    const original = track();
    const clip = { ...shot(), sourceInUs: 2_000_000, durationUs: 500_000 };
    const updated = replaceVisibleCaptionCues(clip, original, [{ id: 'middle', startUs: 0, endUs: 500_000, text: '手动校正' }]);
    expect(updated).toMatchObject({ timeBase: 'source', alignment: 'manual', sourceAssetId: 'audio', sourceSha256: 'source-hash' });
    expect(updated.cues.map(cue => [cue.startUs, cue.endUs, cue.text])).toEqual([
      [0, 1_000_000, '第一句'], [1_500_000, 2_000_000, '识别到的第二句'], [2_000_000, 2_500_000, '手动校正'], [2_500_000, 3_000_000, '识别到的第二句'], [3_500_000, 4_000_000, '最后一句'],
    ]);
    expect(updated.cues[1].id).not.toBe('middle'); expect(updated.cues[3].id).not.toBe('middle');
    expect(new Set(updated.cues.map(cue => cue.id)).size).toBe(updated.cues.length);
    expect(replaceVisibleCaptionCues(clip, original, []).cues).toHaveLength(4);
    expect(() => replaceVisibleCaptionCues(clip, original, [{ id: 'invalid', startUs: 0, endUs: 600_000, text: '越界' }])).toThrow('当前片段');
    expect(original.cues).toEqual(track().cues);
  });

  it('renders explicit timed captions only in their true source intervals', () => {
    const profile = { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180 };
    const scene: SceneFrame = { ...shot(), shotIndex: 0, profile, sourceInUs: 2_000_000, durationUs: 1_500_000, sceneDurationUs: 4_000_000 };
    function pixels(frame: SceneFrame, timeUs: number) {
      const canvas = createCanvas(profile.width, profile.height);
      drawSceneFrame(canvas as unknown as HTMLCanvasElement, frame, timeUs);
      return canvas.toBuffer('image/png');
    }
    const empty = { ...scene, narration: '', captionTrack: { timeBase: 'source' as const, alignment: 'manual' as const, cues: [] } };
    expect(pixels(scene, 200_000)).not.toEqual(pixels(empty, 200_000));
    expect(pixels(scene, 1_100_000)).toEqual(pixels(empty, 1_100_000));
    expect(pixels(scene, 1_000_000)).toEqual(pixels(empty, 1_000_000));
  });

  it('preserves the legacy final authored caption when a preview requests time beyond a cropped scene', () => {
    const profile = { ...DEFAULT_VIDEO_PROFILE, width: 320, height: 180 };
    const scene: SceneFrame = { title: '旧项目', narration: Array.from({ length: 9 }, (_, index) => `第${index + 1}段：这是需要完整保留的旧旁白内容。`).join(''), durationUs: 4_000_000, profile, shotIndex: 0 };
    function pixels(frame: SceneFrame, timeUs: number) {
      const canvas = createCanvas(profile.width, profile.height);
      drawSceneFrame(canvas as unknown as HTMLCanvasElement, frame, timeUs);
      return canvas.toBuffer('image/png');
    }
    expect(pixels({ ...scene, durationUs: 1_000_000, sceneInUs: 1_000_000, sceneDurationUs: 4_000_000 }, 8_000_000).equals(pixels(scene, 4_000_000))).toBe(true);
  });
});
