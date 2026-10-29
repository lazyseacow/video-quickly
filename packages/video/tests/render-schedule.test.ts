import { expect, it } from 'vitest';
import { firstFrameAtUs, timeAtFrame } from '@video-quickly/contracts';
import { createRenderSchedule } from '../src/render-schedule.js';

it('samples a long project once at each target fps without accumulating per-shot padding', () => {
  const shots = Array.from({ length: 100 }, () => ({ durationUs: 1_300_000 }));
  for (const [rate, total] of [[{ numerator: 24, denominator: 1 }, 3120], [{ numerator: 30000, denominator: 1001 }, 3897]] as const) {
    const result = createRenderSchedule(shots, rate);
    expect(result.reduce((sum, clip) => sum + clip.frameCount, 0)).toBe(total);
    expect(result.at(-1)?.endUs).toBe(130_000_000);
    result.forEach((clip, index) => {
      if (index) expect(clip.firstFrame).toBe(result[index - 1].endFrame);
      for (let frame = clip.firstFrame; frame < clip.endFrame; frame++) {
        const timeUs = timeAtFrame(frame, rate);
        expect(timeUs).toBeGreaterThanOrEqual(clip.startUs); expect(timeUs).toBeLessThan(clip.endUs);
      }
    });
  }
});

it('retains partial spans and nonzero first-frame phase on a different target grid', () => {
  const rate = { numerator: 24, denominator: 1 }, durations = [1_300_000, 1_300_000];
  const result = createRenderSchedule(durations.map(durationUs => ({ durationUs })), rate);
  expect(result.map(value => value.frameCount)).toEqual([32, 31]);
  expect(result[1].phaseUs).toBe(33_333);
  const fractional = { numerator: 30000, denominator: 1001 };
  expect(firstFrameAtUs(timeAtFrame(1, fractional), fractional)).toBe(1);
});
