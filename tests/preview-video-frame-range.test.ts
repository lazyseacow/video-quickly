import { afterEach, expect, it, vi } from 'vitest';
import { timeAtFrame } from '@video-quickly/contracts';
import { createPreviewVideoController, previewFrameInRange } from '../src/renderer/components/preview-media';

afterEach(() => vi.unstubAllGlobals());

it('accurately freezes the requested frame when a native decoder stops just before its boundary', () => {
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  const boundaryUs = timeAtFrame(29, { numerator: 30, denominator: 1 });
  const element = Object.assign(new EventTarget(), {
    currentTime: boundaryUs / 1_000_000 - .0005, readyState: 2, duration: 1.6,
    seeking: false, paused: false, ended: false,
    pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(),
  });
  const controller = createPreviewVideoController(element as unknown as HTMLVideoElement, { onFrame: vi.fn(), onReady: vi.fn(), onError: vi.fn() });
  try {
    controller.synchronize(boundaryUs, false, 30, 'outgoing-held-frame');
    expect(element.currentTime).toBe(boundaryUs / 1_000_000);
    expect(element.pause).toHaveBeenCalled();
  } finally { controller.dispose(); }
});

it('rejects the deleted frame both before the program cut and after its source jump', () => {
  const before = { startUs: 0, endUs: 500_000 }, after = { startUs: 533_333, endUs: 1_000_000 };
  expect(previewFrameInRange(14 / 30, before)).toBe(true);
  expect(previewFrameInRange(15 / 30, before)).toBe(false);
  expect(previewFrameInRange(15 / 30, after)).toBe(false);
  expect(previewFrameInRange(16 / 30, after)).toBe(true);
});

it('compares decoded PTS on the persisted microsecond grid at rational frame rates', () => {
  for (const rate of [{ numerator: 30000, denominator: 1001 }, { numerator: 60000, denominator: 1001 }]) {
    const range = { startUs: timeAtFrame(16, rate), endUs: timeAtFrame(20, rate) };
    expect(previewFrameInRange(16 * rate.denominator / rate.numerator, range)).toBe(true);
    expect(previewFrameInRange(20 * rate.denominator / rate.numerator, range)).toBe(false);
    expect(previewFrameInRange(15 * rate.denominator / rate.numerator, range)).toBe(false);
  }
});

it('never admits unknown timestamps or an empty source range', () => {
  for (const time of [NaN, Infinity, -Infinity]) expect(previewFrameInRange(time, { startUs: 0, endUs: 1_000_000 })).toBe(false);
  expect(previewFrameInRange(0, { startUs: 0, endUs: 0 })).toBe(false);
});
