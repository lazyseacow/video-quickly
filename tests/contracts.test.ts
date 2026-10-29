import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_PROFILE, frameAtTime, timeAtFrame, videoProfileSchema } from '@video-quickly/contracts';

describe('video output time and dimensions', () => {
  it('keeps fractional frame indexing aligned over a two-hour edit', () => {
    const rate = { numerator: 30000, denominator: 1001 };
    const originalUs = 2 * 60 * 60 * 1_000_000;
    const frame = frameAtTime(originalUs, rate);
    expect(Math.abs(timeAtFrame(frame, rate) - originalUs)).toBeLessThanOrEqual(1001 * 1_000_000 / 30000 / 2 + 1);
  });
  it('keeps a source timestamp independent of output frame rate', () => {
    const sourceUs = 12_345_000;
    for (const numerator of [24, 25, 30, 50, 60]) {
      const rate = { numerator, denominator: 1 };
      expect(Math.abs(timeAtFrame(frameAtTime(sourceUs, rate), rate) - sourceUs)).toBeLessThanOrEqual(1_000_000 / numerator / 2 + 1);
    }
  });
  it('rejects dimensions incompatible with 4:2:0 output and invalid rates', () => {
    expect(videoProfileSchema.safeParse({ ...DEFAULT_VIDEO_PROFILE, width: 1081 }).success).toBe(false);
    expect(videoProfileSchema.safeParse({ ...DEFAULT_VIDEO_PROFILE, frameRate: { numerator: 0, denominator: 1 } }).success).toBe(false);
    expect(videoProfileSchema.safeParse({ ...DEFAULT_VIDEO_PROFILE, width: 2160, height: 3840, frameRate: { numerator: 60000, denominator: 1001 } }).success).toBe(true);
  });
});
