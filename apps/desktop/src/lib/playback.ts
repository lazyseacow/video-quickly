import { useSyncExternalStore } from 'react';
import { frameAtTime, timeAtFrame, type FrameRate } from '@video-quickly/contracts';

export interface PlaybackSnapshot { timeUs: number; playing: boolean; buffering?: boolean }

export interface PlaybackFrameGate {
  constrainTime: (fromUs: number, requestedUs: number) => number;
  isFrameReady: (timeUs: number) => boolean;
}

// Only the preview and playhead subscribe. Editing panels never consume frame ticks.
export class PlaybackClock {
  private snapshot: PlaybackSnapshot = { timeUs: 0, playing: false };
  private listeners = new Set<() => void>();
  private request: number | undefined;
  private startedAt = 0;
  private startedUs = 0;
  private transportVersion = 0;
  private frameGate: PlaybackFrameGate | undefined;
  constructor(private durationUs: number, private rate: FrameRate) {}

  getSnapshot = () => this.snapshot;
  // Explicit commands can supersede deferred positioning even when seeking to
  // the same frame. Playback ticks and internal pauses are not new intent.
  get transportRevision() { return this.transportVersion; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  attachFrameGate(gate: PlaybackFrameGate) {
    this.frameGate = gate;
    this.refreshFrameGate(gate);
    return () => {
      if (this.frameGate !== gate) return;
      this.frameGate = undefined;
      this.pause();
    };
  }
  refreshFrameGate(gate: PlaybackFrameGate) {
    if (this.frameGate !== gate || !this.snapshot.playing) return;
    if (!gate.isFrameReady(this.snapshot.timeUs)) {
      this.stopRequest();
      // Keep the user's play intent, so pause/seek can cancel a pending resume.
      this.publish(this.snapshot.timeUs, true, true);
    } else if (this.snapshot.buffering) {
      this.anchor(this.snapshot.timeUs);
      this.publish(this.snapshot.timeUs, true);
      this.schedule();
    }
  }
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
    this.anchor(timeUs);
    this.publish(timeUs, true);
    if (this.frameGate) this.refreshFrameGate(this.frameGate);
    this.schedule();
  };
  pause = () => { this.stopRequest(); this.publish(this.snapshot.timeUs, false); };
  dispose = () => { this.frameGate = undefined; this.pause(); };
  private anchor(timeUs: number) { this.startedUs = timeUs; this.startedAt = performance.now(); }
  private schedule() {
    if (this.request !== undefined || !this.snapshot.playing || this.snapshot.buffering) return;
    const request = requestAnimationFrame(() => {
      if (this.request !== request) return;
      this.request = undefined;
      this.tick();
    });
    this.request = request;
  }
  private stopRequest() { if (this.request !== undefined) cancelAnimationFrame(this.request); this.request = undefined; }
  private publish(timeUs: number, playing: boolean, buffering = false) {
    if (timeUs === this.snapshot.timeUs && playing === this.snapshot.playing && buffering === Boolean(this.snapshot.buffering)) return;
    this.snapshot = buffering ? { timeUs, playing, buffering: true } : { timeUs, playing }; this.listeners.forEach(listener => listener());
  }
  private tick = () => {
    if (!this.snapshot.playing || this.snapshot.buffering) return;
    if (this.frameGate && !this.frameGate.isFrameReady(this.snapshot.timeUs)) { this.refreshFrameGate(this.frameGate); return; }
    // RAF timestamps are shared by the entire callback batch. Earlier canvas
    // work can delay this callback while audio advances, so use execution time.
    const elapsedUs = this.startedUs + (performance.now() - this.startedAt) * 1000;
    const frame = Math.floor(elapsedUs * this.rate.numerator / (1_000_000 * this.rate.denominator));
    const requestedUs = Math.min(this.lastTimeUs, timeAtFrame(frame, this.rate));
    const nextUs = this.frameGate?.constrainTime(this.snapshot.timeUs, requestedUs) ?? requestedUs;
    if (nextUs < requestedUs) this.anchor(nextUs);
    else if (elapsedUs >= this.durationUs && (!this.frameGate || this.frameGate.isFrameReady(nextUs))) { this.publish(this.lastTimeUs, false); return; }
    this.publish(nextUs, true);
    this.schedule();
  };
}

export function usePlayback(clock: PlaybackClock) {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
