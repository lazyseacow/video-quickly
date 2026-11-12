import { expect, it } from 'vitest';
import { shotSchema, timeAtFrame } from '@video-quickly/contracts';
import { createTransitionTimeline, sampleTransition, transitionPaddingFrames, wipeLeftIncomingStartX } from '../src/transitions.js';

const shot = (durationUs: number, transition: 'cut' | 'fade' | 'wipe' = 'cut') => shotSchema.parse({ id: String(durationUs), title: 'Shot', narration: '', visualPrompt: '', durationUs, animation: { transition } });

it('holds the preceding global frame until the incoming frame and freezes the outgoing last sampled scene time', () => {
  const rate = { numerator: 24, denominator: 1 }, timeline = createTransitionTimeline([shot(1_300_000), shot(700_000, 'fade')], rate);
  const before = sampleTransition(timeline, 1_300_000)!;
  expect(before).toMatchObject({ frame: 31, shotIndex: 0, timeUs: 1_291_667, localTimeUs: 1_291_667 }); expect(before.outgoing).toBeUndefined();
  const boundary = sampleTransition(timeline, timeAtFrame(32, rate))!;
  expect(boundary).toMatchObject({ frame: 32, shotIndex: 1, localTimeUs: 33_333, outgoing: { shotIndex: 0, localTimeUs: 1_291_667 }, effect: { progress: 0, outgoingProgress: 1, startUs: 1_333_333, durationUs: 200_000 } });
  const next = sampleTransition(timeline, timeAtFrame(33, rate))!;
  expect(next.outgoing).toEqual(boundary.outgoing); expect(next.effect?.progress).toBeCloseTo(41667 / 200000, 6);
  expect(sampleTransition(timeline, timeAtFrame(37, rate))?.effect).toBeUndefined();
});

it('uses tpad nearest-frame padding and skips zero-frame pictures while retaining original shot indexes', () => {
  expect([1, 2, 3, 24, 27, 30, 60].map(numerator => transitionPaddingFrames({ numerator, denominator: 1 }))).toEqual([0, 0, 1, 5, 5, 6, 12]);
  expect(transitionPaddingFrames({ numerator: 5, denominator: 2 })).toBe(1);
  const timeline = createTransitionTimeline([shot(500_000), shot(500_000, 'wipe'), shot(1_000_000, 'fade')], { numerator: 1, denominator: 1 });
  expect(timeline.clips.map(clip => [clip.index, clip.firstFrame, clip.endFrame])).toEqual([[0, 0, 1], [2, 1, 2]]);
  expect(sampleTransition(timeline, 1_000_000)).toMatchObject({ shotIndex: 2, localTimeUs: 0 }); expect(sampleTransition(timeline, 1_000_000)?.effect).toBeUndefined();
  expect(sampleTransition(timeline, 500_000)).toMatchObject({ shotIndex: 0, timeUs: 0 });
});

it('uses the next rendered shot transition across a zero-frame intermediate shot', () => {
  const timeline = createTransitionTimeline([shot(500_000), shot(500_000, 'wipe'), shot(500_000, 'cut'), shot(500_000, 'fade')], { numerator: 1, denominator: 1 });
  expect(timeline.clips.map(clip => clip.index)).toEqual([0, 2]); expect(timeline.clips[1].transition).toBe('cut');
  expect(sampleTransition(timeline, 1_500_000)).toMatchObject({ shotIndex: 2 });
});

it('matches wipeleft direction and the strict boundary column', () => {
  expect(wipeLeftIncomingStartX(64, 1)).toBe(64);
  expect(wipeLeftIncomingStartX(64, .5)).toBe(33);
  expect(wipeLeftIncomingStartX(64, 0)).toBe(1);
});

it('retains a fractional frame boundary, clamps finite out-of-range times, and handles an empty timeline', () => {
  const rate = { numerator: 30000, denominator: 1001 }, timeline = createTransitionTimeline([shot(1_300_000), shot(700_000, 'fade')], rate), first = timeline.clips[1].firstFrame;
  expect(sampleTransition(timeline, timeAtFrame(first, rate) - 1)?.shotIndex).toBe(0);
  expect(sampleTransition(timeline, timeAtFrame(first, rate))?.shotIndex).toBe(1);
  expect(sampleTransition(timeline, -1)?.frame).toBe(0); expect(sampleTransition(timeline, 9_000_000)?.frame).toBe(timeline.totalFrames - 1);
  expect(sampleTransition(createTransitionTimeline([], rate), 0)).toBeUndefined();
  expect(() => sampleTransition(timeline, NaN)).toThrow('有限数值');
});
