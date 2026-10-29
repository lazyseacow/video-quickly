import type { AudioWaveform } from '@video-quickly/contracts';

export interface WaveformSpan { outputStartUs: number; durationUs: number; sourceInUs: number }

/** A display column may cross a cut; only retained source intervals contribute measured peaks. */
export function waveformSpanColumns(waveform: AudioWaveform, spans: readonly WaveformSpan[], durationUs: number, count: number): number[] {
  const columns = Math.max(1, Math.floor(count)), widthUs = durationUs / columns;
  let first = 0;
  return Array.from({ length: columns }, (_, index) => {
    const startUs = index * widthUs, endUs = (index + 1) * widthUs;
    while (first < spans.length && spans[first].outputStartUs + spans[first].durationUs <= startUs) first++;
    let peak = 0;
    for (let cursor = first; cursor < spans.length && spans[cursor].outputStartUs < endUs; cursor++) {
      const span = spans[cursor], from = Math.max(startUs, span.outputStartUs), to = Math.min(endUs, span.outputStartUs + span.durationUs);
      if (to > from) peak = Math.max(peak, waveformColumns(waveform, span.sourceInUs + from - span.outputStartUs, to - from, 1)[0]);
    }
    return peak;
  });
}

/** Each displayed column keeps the maximum measured peak in its source interval. */
export function waveformColumns(waveform: AudioWaveform, sourceInUs: number, durationUs: number, count: number, loop = false): number[] {
  const windowUs = 1_000_000 / waveform.peaksPerSecond;
  const peakBetween = (startUs: number, endUs: number) => {
    let peak = 0;
    const start = Math.max(0, Math.floor(startUs / windowUs));
    const end = Math.min(waveform.peaks.length, Math.ceil(Math.min(endUs, waveform.durationUs) / windowUs));
    for (let index = start; index < end; index++) peak = Math.max(peak, waveform.peaks[index]);
    return peak;
  };
  const periodUs = waveform.durationUs - sourceInUs;
  const columns = Math.max(1, Math.floor(count));
  const widthUs = durationUs / columns;
  const loopPeak = loop && periodUs > 0 && widthUs >= periodUs ? peakBetween(sourceInUs, waveform.durationUs) : undefined;
  return Array.from({ length: columns }, (_, index) => {
    if (!loop) return peakBetween(sourceInUs + index * widthUs, sourceInUs + (index + 1) * widthUs);
    if (periodUs <= 0) return 0;
    if (loopPeak !== undefined) return loopPeak;
    const start = sourceInUs + index * widthUs % periodUs;
    const end = start + widthUs;
    return Math.max(peakBetween(start, end), end > waveform.durationUs ? peakBetween(sourceInUs, sourceInUs + end - waveform.durationUs) : 0);
  });
}
