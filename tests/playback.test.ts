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

  it('uses execution time when an earlier animation callback stalls the shared frame timestamp', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    clock.toggle();
    const pending = [...callbacks.values()]; callbacks.clear();
    // Every RAF callback in a batch receives 34ms, even if an earlier callback
    // blocks for 180ms before this clock gets to run. The audio keeps advancing.
    now = 214; pending.forEach(callback => callback(34));
    expect(clock.getSnapshot()).toEqual({ playing: true, timeUs: 200_000 });
    clock.pause(); clock.seek(1_000_000); clock.toggle();
    advance(34);
    expect(clock.getSnapshot()).toEqual({ playing: true, timeUs: 1_033_333 });
    clock.dispose(); expect(callbacks.size).toBe(0);
  });

  it('steps exactly one fractional-rate frame in either direction', () => {
    const clock = new PlaybackClock(2_000_000, { numerator: 30000, denominator: 1001 });
    clock.step(1); expect(clock.getSnapshot().timeUs).toBe(33367);
    clock.step(1); expect(clock.getSnapshot().timeUs).toBe(66733);
    clock.step(-1); expect(clock.getSnapshot().timeUs).toBe(33367);
    clock.step(-10); expect(clock.getSnapshot().timeUs).toBe(0);
  });

  it('records explicit transport intent even on the same frame, without treating ticks or internal pauses as commands', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30000, denominator: 1001 });
    const initial = clock.getSnapshot();
    expect(clock.transportRevision).toBe(0);
    clock.seek(0);
    expect(clock.getSnapshot()).toBe(initial);
    expect(clock.transportRevision).toBe(1);
    for (let index = 0; index < 6; index++) clock.step(10);
    expect(clock.getSnapshot()).toEqual({ playing: false, timeUs: 2_002_000 });
    expect(clock.transportRevision).toBe(7);
    clock.toggle();
    expect(clock.transportRevision).toBe(8);
    advance(1000);
    expect(clock.transportRevision).toBe(8);
    clock.pause();
    expect(clock.transportRevision).toBe(8);
    clock.configure(9_000_000, { numerator: 30, denominator: 1 });
    expect(clock.transportRevision).toBe(8);
    clock.toggle(); clock.toggle();
    expect(clock.transportRevision).toBe(10);
    expect(clock.getSnapshot().playing).toBe(false);
  });

  it('positions deferred selections only while their transport intent is current, preserving consecutive selections', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30000, denominator: 1001 });
    const revision = clock.transportRevision;
    clock.seekIfUnchanged(revision, 3_000_000);
    expect(clock.getSnapshot().timeUs).toBe(3_003_000);
    clock.seekIfUnchanged(revision, 4_500_000);
    expect(clock.getSnapshot().timeUs).toBe(4_504_500);
    clock.seek(0);
    const homeRevision = clock.transportRevision;
    clock.seek(0);
    clock.seekIfUnchanged(homeRevision, 3_000_000);
    expect(clock.getSnapshot().timeUs).toBe(0);
    const current = clock.transportRevision;
    clock.configure(12_000_000, { numerator: 30, denominator: 1 });
    clock.pause();
    clock.seekIfUnchanged(current, 3_000_000);
    expect(clock.getSnapshot().timeUs).toBe(3_000_000);
    clock.toggle();
    advance(1000);
    clock.seekIfUnchanged(current, 0);
    expect(clock.getSnapshot()).toEqual({ playing: true, timeUs: 4_000_000 });
    clock.dispose();
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
