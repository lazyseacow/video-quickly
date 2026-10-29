import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackClock } from '../apps/desktop/src/lib/playback';

describe('local preview clock', () => {
  let now = 0;
  let sequence = 0;
  let callbacks: Map<number, FrameRequestCallback>;
  beforeEach(() => {
    now = 0; callbacks = new Map();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function advance(milliseconds: number) { now += milliseconds; const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(now)); }

  it('publishes only new project frames and catches up to wall time after a stall', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    const listener = vi.fn(); clock.subscribe(listener); clock.toggle();
    advance(10); advance(10);
    expect(listener).toHaveBeenCalledTimes(1);
    advance(14);
    expect(clock.getSnapshot()).toEqual({ playing: true, timeUs: 33333 });
    advance(1000);
    expect(clock.getSnapshot().timeUs).toBe(1033333);
    clock.dispose(); expect(callbacks.size).toBe(0);
  });

  it('steps exactly one fractional-rate frame in either direction', () => {
    const clock = new PlaybackClock(2_000_000, { numerator: 30000, denominator: 1001 });
    clock.step(1); expect(clock.getSnapshot().timeUs).toBe(33367);
    clock.step(1); expect(clock.getSnapshot().timeUs).toBe(66733);
    clock.step(-1); expect(clock.getSnapshot().timeUs).toBe(33367);
    clock.step(-10); expect(clock.getSnapshot().timeUs).toBe(0);
  });

  it('stops on the final valid frame, can replay and pauses without background ticks', () => {
    const clock = new PlaybackClock(500_000, { numerator: 120, denominator: 1 });
    clock.toggle(); advance(500);
    expect(clock.getSnapshot()).toEqual({ playing: false, timeUs: 491667 });
    expect(callbacks.size).toBe(0);
    clock.toggle(); expect(clock.getSnapshot()).toEqual({ playing: true, timeUs: 0 });
    advance(50); clock.pause(); advance(500);
    expect(clock.getSnapshot()).toEqual({ playing: false, timeUs: 50000 });
    expect(callbacks.size).toBe(0);
  });

  it('reconfigures an edited timeline safely and allows unsubscribing', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 60, denominator: 1 });
    const listener = vi.fn(); const unsubscribe = clock.subscribe(listener);
    clock.seek(5_000_000); clock.toggle();
    clock.configure(1_000_000, { numerator: 25, denominator: 1 });
    expect(clock.getSnapshot()).toEqual({ playing: false, timeUs: 960000 });
    expect(callbacks.size).toBe(0);
    unsubscribe(); listener.mockClear(); clock.seek(0); expect(listener).not.toHaveBeenCalled();
  });
});
