import { useSyncExternalStore } from 'react';
import { frameAtTime, timeAtFrame, type FrameRate } from '@video-quickly/contracts';

export interface PlaybackSnapshot { timeUs: number; playing: boolean }

// Only the preview and playhead subscribe. Editing panels never consume frame ticks.
export class PlaybackClock {
  private snapshot: PlaybackSnapshot = { timeUs: 0, playing: false };
  private listeners = new Set<() => void>();
  private request: number | undefined;
  private startedAt = 0;
  private startedUs = 0;
  private transportVersion = 0;
  constructor(private durationUs: number, private rate: FrameRate) {}

  getSnapshot = () => this.snapshot;
  // Explicit commands can supersede deferred positioning even when seeking to
  // the same frame. Playback ticks and internal pauses are not new intent.
  get transportRevision() { return this.transportVersion; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get lastTimeUs() {
    const frames = Math.ceil(this.durationUs * this.rate.numerator / (1_000_000 * this.rate.denominator) - .0001);
    return Math.max(0, timeAtFrame(frames - 1, this.rate));
  }
  configure(durationUs: number, rate: FrameRate) {
    if (durationUs === this.durationUs && rate.numerator === this.rate.numerator && rate.denominator === this.rate.denominator) return;
    this.pause(); this.durationUs = durationUs; this.rate = rate; this.applySeek(this.snapshot.timeUs);
  }
  seek = (timeUs: number) => {
    this.transportVersion++;
    this.applySeek(timeUs);
  };
  seekIfUnchanged = (revision: number, timeUs: number) => {
    if (this.transportVersion === revision) this.applySeek(timeUs);
  };
  private applySeek(timeUs: number) {
    this.stopRequest();
    const aligned = timeAtFrame(Math.max(0, frameAtTime(timeUs, this.rate)), this.rate);
    this.publish(Math.min(this.lastTimeUs, aligned), false);
  }
  step = (frames: number) => this.seek(timeAtFrame(frameAtTime(this.snapshot.timeUs, this.rate) + frames, this.rate));
  toggle = () => {
    this.transportVersion++;
    if (this.snapshot.playing) { this.pause(); return; }
    if (!this.durationUs) return;
    const timeUs = this.snapshot.timeUs >= this.lastTimeUs ? 0 : this.snapshot.timeUs;
    this.startedUs = timeUs; this.startedAt = performance.now();
    this.publish(timeUs, true); this.request = requestAnimationFrame(this.tick);
  };
  pause = () => { this.stopRequest(); this.publish(this.snapshot.timeUs, false); };
  dispose = () => this.stopRequest();
  private stopRequest() { if (this.request !== undefined) cancelAnimationFrame(this.request); this.request = undefined; }
  private publish(timeUs: number, playing: boolean) {
    if (timeUs === this.snapshot.timeUs && playing === this.snapshot.playing) return;
    this.snapshot = { timeUs, playing }; this.listeners.forEach(listener => listener());
  }
  private tick = (now: number) => {
    const elapsedUs = this.startedUs + (now - this.startedAt) * 1000;
    if (elapsedUs >= this.durationUs) { this.request = undefined; this.publish(this.lastTimeUs, false); return; }
    const frame = Math.floor(elapsedUs * this.rate.numerator / (1_000_000 * this.rate.denominator));
    this.publish(Math.min(this.lastTimeUs, timeAtFrame(frame, this.rate)), true);
    this.request = requestAnimationFrame(this.tick);
  };
}

export function usePlayback(clock: PlaybackClock) {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
