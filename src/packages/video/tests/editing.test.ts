import { describe, expect, it } from 'vitest';
import { frameAtTime, shotSchema, timeAtFrame } from '@video-quickly/contracts';
import { canSplitShot, maximumSourceOutUs, minimumShotDurationUs, minimumSourceInUs, reorderShots, snapTimeUs, splitShot, trimShot } from '../src/editing.js';

const rate = { numerator: 30_000, denominator: 1001 };
const shot = () => shotSchema.parse({ id: 'source', title: '原镜头', narration: '完整旁白', visualPrompt: '画面要求', durationUs: timeAtFrame(120, rate), videoAssetId: 'video', audioAssetId: 'voice', assetId: 'image', claimIds: ['claim'], locked: true });

describe('frame-aligned clip editing', () => {
  it('keeps legacy projects valid and rejects invalid media offsets at the input boundary', () => {
    expect(shot().sourceInUs).toBeUndefined();
    expect(shotSchema.safeParse({ ...shot(), sourceInUs: -1 }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot(), audioInUs: -1 }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot(), videoInUs: .5 }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot(), sceneInUs: .5 }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot(), sceneDurationUs: 0 }).success).toBe(false);
    expect(shotSchema.parse({ ...shot(), sceneIndex: 6 }).sceneIndex).toBe(6);
    expect(shotSchema.safeParse({ ...shot(), sceneIndex: -1 }).success).toBe(false);
    expect(shotSchema.safeParse({ ...shot(), sceneIndex: 1.5 }).success).toBe(false);
  });

  it('splits fractional-frame media continuously and gives the new cut its own identity', () => {
    const original = { ...shot(), sourceInUs: timeAtFrame(30, rate), sceneInUs: timeAtFrame(15, rate), sceneDurationUs: timeAtFrame(180, rate), sceneIndex: 6 };
    const [left, right] = splitShot(original, timeAtFrame(39, rate) + 100, rate, 'right');
    expect(left.durationUs).toBe(timeAtFrame(39, rate));
    expect(left.durationUs + right.durationUs).toBe(original.durationUs);
    expect(right).toMatchObject({ id: 'right', sourceInUs: original.sourceInUs + left.durationUs, sceneInUs: original.sceneInUs + left.durationUs, sceneDurationUs: original.sceneDurationUs, narration: original.narration, videoAssetId: 'video', audioAssetId: 'voice', assetId: 'image', claimIds: ['claim'], locked: true });
    expect(right.animation.transition).toBe('cut'); expect(left.animation.transition).toBe('fade');
    expect(left.sceneIndex).toBe(6); expect(right.sceneIndex).toBe(6);
    expect(shotSchema.safeParse(left).success).toBe(true); expect(shotSchema.safeParse(right).success).toBe(true);
    expect(original.durationUs).toBe(timeAtFrame(120, rate));
  });

  it('keeps nested splits on the original authored scene rather than restarting narration or movement', () => {
    const original = { ...shot(), sceneIndex: 6 };
    const [, right] = splitShot(original, timeAtFrame(39, rate), rate, 'right');
    const [middle, tail] = splitShot(right, timeAtFrame(30, rate), rate, 'tail');
    expect(middle.sourceInUs).toBe(timeAtFrame(39, rate));
    expect(tail.sourceInUs).toBe(timeAtFrame(39, rate) + timeAtFrame(30, rate));
    expect(tail.sceneInUs).toBe(tail.sourceInUs); expect(tail.sceneDurationUs).toBe(original.durationUs);
    expect(middle.sceneIndex).toBe(6); expect(tail.sceneIndex).toBe(6);
  });

  it('rejects short split fragments and enforces whole-frame minimums at 29.97 and 59.94 fps', () => {
    for (const frameRate of [rate, { numerator: 60_000, denominator: 1001 }]) {
      const minimum = minimumShotDurationUs(frameRate);
      const minimumFrames = frameAtTime(minimum, frameRate);
      expect(minimum).toBeGreaterThanOrEqual(500_000);
      expect(timeAtFrame(minimumFrames - 1, frameRate)).toBeLessThan(500_000);
      expect(canSplitShot(shot(), minimum - 100_000, frameRate)).toBe(false);
      expect(() => splitShot(shot(), 10, frameRate, 'right')).toThrow('半秒');
      expect(() => splitShot(shot(), shot().durationUs, frameRate, 'right')).toThrow('半秒');
    }
    expect(() => splitShot(shot(), 1_000_000, rate, 'source')).toThrow('独立编号');
  });

  it('trims and extends source bounds without losing the original animation timing', () => {
    const original = { ...shot(), sceneIndex: 6 };
    const trimmed = trimShot(original, { inUs: timeAtFrame(15, rate), outUs: timeAtFrame(90, rate) }, rate);
    expect(trimmed.sourceInUs).toBe(timeAtFrame(15, rate)); expect(trimmed.sceneInUs).toBe(timeAtFrame(15, rate));
    expect(trimmed.durationUs).toBe(timeAtFrame(90, rate) - timeAtFrame(15, rate));
    expect(trimmed.sceneDurationUs).toBe(original.durationUs);
    const extended = trimShot(trimmed, { inUs: 0, outUs: timeAtFrame(180, rate) }, rate);
    expect(extended.sceneInUs).toBe(0); expect(extended.sceneDurationUs).toBe(original.durationUs);
    expect(extended.durationUs).toBe(timeAtFrame(180, rate));
    expect(trimmed.sceneIndex).toBe(6); expect(extended.sceneIndex).toBe(6);
    expect(shotSchema.safeParse(extended).success).toBe(true);
    expect(() => trimShot(original, { inUs: 0, outUs: 100_000 }, rate)).toThrow('片段至少保留 0.5 秒');
    for (const range of [{ inUs: -1, outUs: 1_000_000 }, { inUs: 1_000_000, outUs: 0 }, { inUs: 0, outUs: NaN }, { inUs: 0, outUs: 100_000 }]) expect(() => trimShot(original, range, rate)).toThrow();
  });

  it('keeps the exact two-second source endpoint inside its final complete frame', () => {
    const trimmed = trimShot(shot(), { inUs: 0, outUs: 2_000_000 }, rate, 2_000_000);
    expect(trimmed.durationUs).toBe(1_968_633);
    expect((trimmed.sourceInUs ?? 0) + trimmed.durationUs).toBeLessThanOrEqual(2_000_000);
    const fastRate = { numerator: 60_000, denominator: 1001 };
    expect(trimShot(shot(), { inUs: 0, outUs: 2_000_000 }, fastRate, 2_000_000).durationUs).toBe(1_985_317);
    const shifted = trimShot({ ...shot(), sourceInUs: timeAtFrame(15, rate), sceneInUs: timeAtFrame(30, rate) }, { inUs: timeAtFrame(30, rate), outUs: 2_000_000 }, rate, 2_000_000);
    expect((shifted.sourceInUs ?? 0) + shifted.durationUs).toBe(1_968_633);
    expect(shifted.sceneInUs).toBe(timeAtFrame(45, rate));
  });

  it('preserves stored frame endpoints while rounding only incomplete source frames down', () => {
    expect(maximumSourceOutUs(2_000_000, rate)).toBe(1_968_633);
    const aligned = timeAtFrame(17, rate);
    expect(maximumSourceOutUs(aligned, rate)).toBe(aligned);
    expect(maximumSourceOutUs(aligned - 1, rate)).toBe(timeAtFrame(16, rate));
    expect(maximumSourceOutUs(1, rate)).toBe(0);
    for (const durationUs of [0, -1, NaN, Infinity]) expect(() => maximumSourceOutUs(durationUs, rate)).toThrow('素材时长');
  });

  it('rejects actual source overruns and keeps legacy unbounded frame alignment', () => {
    expect(() => trimShot(shot(), { inUs: 0, outUs: 2_000_001 }, rate, 2_000_000)).toThrow('真实时长');
    expect(() => trimShot(shot(), { inUs: 0, outUs: 3_000_000 }, rate, 2_000_000)).toThrow('真实时长');
    expect(() => trimShot(shot(), { inUs: 0, outUs: 2_000_000 }, rate, NaN)).toThrow('素材时长');
    expect(trimShot(shot(), { inUs: 0, outUs: 2_000_000 }, rate).durationUs).toBe(2_002_000);
  });

  it('advances independent media offsets through splits and common trims without resetting other sources', () => {
    const original = { ...shot(), sourceInUs: timeAtFrame(60, rate), audioInUs: 0, videoInUs: timeAtFrame(90, rate) };
    const [left, right] = splitShot(original, timeAtFrame(39, rate), rate, 'right');
    expect(left.audioInUs).toBe(0); expect(left.videoInUs).toBe(original.videoInUs);
    expect(right.audioInUs).toBe(timeAtFrame(39, rate));
    expect(right.videoInUs).toBe(original.videoInUs + timeAtFrame(39, rate));
    expect(right.sourceInUs).toBe(original.sourceInUs + timeAtFrame(39, rate));
    const trimmed = trimShot(original, { inUs: timeAtFrame(75, rate), outUs: timeAtFrame(150, rate) }, rate);
    expect(trimmed.audioInUs).toBe(timeAtFrame(15, rate));
    expect(trimmed.videoInUs).toBe(timeAtFrame(105, rate));
    expect(minimumSourceInUs(original)).toBe(original.sourceInUs);
    expect(() => trimShot(original, { inUs: timeAtFrame(59, rate), outUs: timeAtFrame(150, rate) }, rate)).toThrow('早于 0 秒');
    const legacy = splitShot(shot(), timeAtFrame(39, rate), rate, 'legacy')[1];
    expect(legacy.audioInUs).toBeUndefined(); expect(legacy.videoInUs).toBeUndefined();
  });

  it('ceil-aligns independent media minimums and ignores overrides without an associated asset', () => {
    const original = { ...shot(), sourceInUs: timeAtFrame(60, rate), audioInUs: 20_000 };
    const minimum = minimumSourceInUs(original);
    expect(minimum).toBe(1_982_000);
    const trimmed = trimShot(original, { inUs: minimum, outUs: timeAtFrame(120, rate) }, rate);
    expect(trimmed.sourceInUs).toBe(timeAtFrame(60, rate));
    expect(trimmed.audioInUs).toBe(20_000);
    const unlinked = { ...original, audioAssetId: undefined, videoAssetId: undefined, videoInUs: 0 };
    expect(minimumSourceInUs(unlinked)).toBe(0);
    const moved = trimShot(unlinked, { inUs: 0, outUs: 1_001_000 }, rate);
    expect(moved.sourceInUs).toBe(0); expect(moved.audioInUs).toBe(20_000); expect(moved.videoInUs).toBe(0);
  });

  it('moves a clip to its final index without mutating the source list or its shots', () => {
    const clips = ['a', 'b', 'c'].map((id, sceneIndex) => ({ ...shot(), id, sceneIndex }));
    expect(reorderShots(clips, 'a', 2).map(clip => clip.id)).toEqual(['b', 'c', 'a']);
    expect(reorderShots(clips, 'c', 0).map(clip => clip.id)).toEqual(['c', 'a', 'b']);
    expect(clips.map(clip => clip.id)).toEqual(['a', 'b', 'c']);
    expect(reorderShots(clips, 'b', 1)[1]).toBe(clips[1]);
    expect(reorderShots(clips, 'a', 2).map(clip => clip.sceneIndex)).toEqual([1, 2, 0]);
    expect(() => reorderShots(clips, 'missing', 0)).toThrow('不存在');
    expect(() => reorderShots(clips, 'a', 3)).toThrow('位置无效');
  });

  it('snaps to the closest eligible anchor while keeping every result on the frame grid', () => {
    const anchor = timeAtFrame(30, rate);
    expect(snapTimeUs(anchor + 20_000, rate, [anchor], 50_000)).toBe(anchor);
    expect(snapTimeUs(anchor + 100_000, rate, [anchor], 50_000)).not.toBe(anchor);
    expect(snapTimeUs(-100, rate)).toBe(0);
    const aligned = snapTimeUs(1_234_567, rate);
    expect(aligned).toBe(timeAtFrame(frameAtTime(aligned, rate), rate));
    expect(snapTimeUs(timeAtFrame(30, rate), rate, [timeAtFrame(29, rate), timeAtFrame(31, rate)], 40_000)).toBe(timeAtFrame(29, rate));
  });
});
