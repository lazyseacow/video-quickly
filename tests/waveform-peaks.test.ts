import { expect, it } from 'vitest';
import type { AudioWaveform } from '@video-quickly/contracts';
import { waveformColumns } from '../apps/desktop/src/lib/waveform-peaks';

const waveform: AudioWaveform = { version: 1, assetId: 'voice', sha256: 'hash', durationUs: 40_000, peaksPerSecond: 100, peaks: [.1, .5, .9, .3] };

it('projects the real source interval after trimming or splitting and preserves silent tails', () => {
  expect(waveformColumns(waveform, 10_000, 20_000, 2)).toEqual([.5, .9]);
  expect(waveformColumns(waveform, 20_000, 40_000, 4)).toEqual([.9, .3, 0, 0]);
  expect(waveformColumns(waveform, 0, 40_000, 2)).toEqual([.5, .9]);
});

it('loops the selected music tail and retains a peak when a column crosses the loop boundary', () => {
  expect(waveformColumns(waveform, 20_000, 60_000, 6, true)).toEqual([.9, .3, .9, .3, .9, .3]);
  expect(waveformColumns(waveform, 20_000, 60_000, 2, true)).toEqual([.9, .9]);
  expect(waveformColumns(waveform, 40_000, 20_000, 2, true)).toEqual([0, 0]);
});
