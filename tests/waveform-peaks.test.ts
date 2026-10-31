import { expect, it } from 'vitest';
import type { AudioWaveform } from '@video-quickly/contracts';
import { waveformColumns } from '../apps/desktop/src/lib/waveform-peaks';

const waveform: AudioWaveform = { version: 1, assetId: 'voice', sha256: 'hash', durationUs: 40_000, peaksPerSecond: 100, peaks: [.1, .5, .9, .3] };

it('projects the real source interval after trimming or splitting and preserves silent tails', () => {
  expect(waveformColumns(waveform, 10_000, 20_000, 2)).toEqual([.5, .9]);
  expect(waveformColumns(waveform, 20_000, 40_000, 4)).toEqual([.9, .3, 0, 0]);
  expect(waveformColumns(waveform, 0, 40_000, 2)).toEqual([.5, .9]);
});

it('keeps a split window end exclusive when its display width produces fractional columns', () => {
  const source: AudioWaveform = { ...waveform, durationUs: 2_000_000, peaks: [...Array(100).fill(.2), ...Array(100).fill(.8)] };
  for (const columns of [7, 14, 15, 28, 41, 49, 60, 95]) {
    expect(waveformColumns(source, 0, 1_000_000, columns), `${columns} columns must not read the next source window`).toEqual(Array(columns).fill(.2));
    expect(waveformColumns(source, 0, 1_000_000, columns, true), `${columns} music columns before the first loop must keep the same endpoint`).toEqual(Array(columns).fill(.2));
  }
});

it('loops the selected music tail and retains a peak when a column crosses the loop boundary', () => {
  expect(waveformColumns(waveform, 20_000, 60_000, 6, true)).toEqual([.9, .3, .9, .3, .9, .3]);
  expect(waveformColumns(waveform, 20_000, 60_000, 2, true)).toEqual([.9, .9]);
  expect(waveformColumns(waveform, 40_000, 20_000, 2, true)).toEqual([0, 0]);
});
