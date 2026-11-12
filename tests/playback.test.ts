import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackClock } from '../src/renderer/lib/playback';

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

  it('plays a bounded preview once and then allows ordinary playback past its endpoint', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    clock.playRange(600_000, 1_600_000);
    expect(clock.getSnapshot()).toEqual({ timeUs: 600_000, playing: true });
    advance(500); expect(clock.getSnapshot()).toEqual({ timeUs: 1_100_000, playing: true });
    advance(700); expect(clock.getSnapshot()).toEqual({ timeUs: 1_600_000, playing: false });
    expect(callbacks.size).toBe(0);
    clock.toggle(); advance(500);
    expect(clock.getSnapshot()).toEqual({ timeUs: 2_100_000, playing: true });
    clock.dispose();
  });

  it('keeps a preview range while buffering and acknowledges its final picture before pausing', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    let readyUs = -1;
    const gate = { constrainTime: (_from: number, requested: number) => requested, isFrameReady: (timeUs: number) => timeUs === readyUs };
    clock.attachFrameGate(gate); clock.playRange(600_000, 1_600_000); advance(2000);
    expect(clock.getSnapshot()).toEqual({ timeUs: 600_000, playing: true, buffering: true });
    readyUs = 600_000; clock.refreshFrameGate(gate); advance(1500); clock.refreshFrameGate(gate);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_600_000, playing: true, buffering: true });
    advance(2000); readyUs = 1_600_000; clock.refreshFrameGate(gate); advance(34);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_600_000, playing: false });
    expect(callbacks.size).toBe(0); clock.dispose();
  });

  it('presents an unseen transition boundary before completing a stalled preview range', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    clock.attachFrameGate({ constrainTime: (from, requested) => from < 1_000_000 && requested >= 1_000_000 ? 1_000_000 : requested, isFrameReady: () => true });
    clock.playRange(600_000, 1_600_000); advance(5000);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_000_000, playing: true });
    advance(700); expect(clock.getSnapshot()).toEqual({ timeUs: 1_600_000, playing: false });
    clock.dispose();
  });

  it('replaces a playing preview range and ignores its canceled animation callback', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    clock.playRange(600_000, 1_600_000); const canceled = [...callbacks.values()][0];
    clock.playRange(3_000_000, 3_500_000); canceled(now);
    expect(clock.getSnapshot()).toEqual({ timeUs: 3_000_000, playing: true });
    expect(callbacks.size).toBe(1);
    advance(250); expect(clock.getSnapshot().playing).toBe(true);
    advance(300); expect(clock.getSnapshot()).toEqual({ timeUs: 3_500_000, playing: false });
    expect(callbacks.size).toBe(0); clock.dispose();
  });

  for (const command of ['pause', 'toggle', 'seek', 'configure'] as const) it(`clears the preview endpoint after a user ${command}`, () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    clock.playRange(600_000, 1_600_000); advance(200);
    if (command === 'pause') clock.pause();
    if (command === 'toggle') clock.toggle();
    if (command === 'seek') clock.seek(3_000_000);
    if (command === 'configure') clock.configure(9_000_000, { numerator: 30, denominator: 1 });
    expect(clock.getSnapshot().playing).toBe(false);
    clock.toggle(); advance(2000);
    expect(clock.getSnapshot().playing).toBe(true); expect(clock.getSnapshot().timeUs).toBeGreaterThan(1_600_000);
    clock.dispose();
  });

  it('clamps preview ranges to valid project frames and leaves an empty range paused', () => {
    const clock = new PlaybackClock(2_000_000, { numerator: 30000, denominator: 1001 });
    clock.playRange(-1_000_000, 10_000_000); advance(3000);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_968_633, playing: false });
    clock.playRange(1_000_000, 500_000);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_001_000, playing: false });
    expect(callbacks.size).toBe(0); clock.dispose();
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

  it('holds play intent and discards elapsed loading time until the exact picture is acknowledged', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    let readyUs = -1;
    const gate = { constrainTime: (_from: number, requested: number) => requested, isFrameReady: (timeUs: number) => timeUs === readyUs };
    clock.attachFrameGate(gate); clock.toggle();
    expect(clock.getSnapshot()).toEqual({ timeUs: 0, playing: true, buffering: true });
    expect(callbacks.size).toBe(0);
    advance(1300);
    expect(clock.getSnapshot().timeUs).toBe(0);
    readyUs = 0; clock.refreshFrameGate(gate); clock.refreshFrameGate(gate);
    expect(clock.getSnapshot()).toEqual({ timeUs: 0, playing: true }); expect(callbacks.size).toBe(1);
    advance(34); clock.refreshFrameGate(gate);
    expect(clock.getSnapshot()).toEqual({ timeUs: 33333, playing: true, buffering: true });
    advance(900); readyUs = 33333; clock.refreshFrameGate(gate);
    advance(34);
    expect(clock.getSnapshot()).toEqual({ timeUs: 66667, playing: true });
    clock.dispose();
  });

  it('clamps a stalled tick to the first incoming sample and re-anchors its transition clock', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    const gate = { constrainTime: (from: number, requested: number) => from < 1_000_000 && requested >= 1_000_000 ? 1_000_000 : requested, isFrameReady: () => true };
    clock.attachFrameGate(gate); clock.toggle(); advance(1450);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_000_000, playing: true });
    advance(34);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_033_333, playing: true });
    clock.dispose();
  });

  it('still presents an unseen boundary when a stalled RAF runs past the project end', () => {
    const clock = new PlaybackClock(2_000_000, { numerator: 30, denominator: 1 });
    const gate = { constrainTime: (from: number, requested: number) => from < 1_000_000 && requested >= 1_000_000 ? 1_000_000 : requested, isFrameReady: () => true };
    clock.attachFrameGate(gate); clock.toggle(); advance(2500);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_000_000, playing: true });
    advance(34); expect(clock.getSnapshot()).toEqual({ timeUs: 1_033_333, playing: true });
    clock.dispose();
  });

  it('waits for the last picture before completing a gated project', () => {
    const clock = new PlaybackClock(2_000_000, { numerator: 30, denominator: 1 });
    let readyUs = 0;
    const gate = { constrainTime: (_from: number, requested: number) => requested, isFrameReady: (timeUs: number) => timeUs === readyUs };
    clock.attachFrameGate(gate); clock.toggle(); advance(2500); clock.refreshFrameGate(gate);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_966_667, playing: true, buffering: true });
    advance(500); readyUs = 1_966_667; clock.refreshFrameGate(gate); advance(34);
    expect(clock.getSnapshot()).toEqual({ timeUs: 1_966_667, playing: false }); expect(callbacks.size).toBe(0);
    clock.dispose();
  });

  for (const command of ['pause', 'toggle', 'seek', 'deferred-seek', 'configure', 'detach', 'dispose'] as const) it(`does not resume a buffered frame after ${command}`, () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    let ready = false;
    const gate = { constrainTime: (_from: number, requested: number) => requested, isFrameReady: () => ready };
    const detach = clock.attachFrameGate(gate); clock.toggle();
    expect(clock.getSnapshot().buffering).toBe(true);
    if (command === 'pause') clock.pause();
    if (command === 'toggle') clock.toggle();
    if (command === 'seek') clock.seek(500_000);
    if (command === 'deferred-seek') clock.seekIfUnchanged(clock.transportRevision, 500_000);
    if (command === 'configure') clock.configure(9_000_000, { numerator: 60, denominator: 1 });
    if (command === 'detach') detach();
    if (command === 'dispose') clock.dispose();
    ready = true; clock.refreshFrameGate(gate); advance(1000);
    expect(clock.getSnapshot().playing).toBe(false); expect(clock.getSnapshot().buffering).toBeUndefined(); expect(callbacks.size).toBe(0);
    clock.dispose();
  });

  it('ignores obsolete owners and can reattach after a StrictMode cleanup', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    const oldGate = { constrainTime: (_from: number, requested: number) => requested, isFrameReady: () => false };
    const detachOld = clock.attachFrameGate(oldGate); clock.toggle();
    let ready = false;
    const gate = { ...oldGate, isFrameReady: () => ready };
    clock.attachFrameGate(gate); detachOld();
    ready = true; clock.refreshFrameGate(oldGate);
    expect(clock.getSnapshot().buffering).toBe(true); expect(callbacks.size).toBe(0);
    clock.refreshFrameGate(gate);
    expect(clock.getSnapshot()).toEqual({ timeUs: 0, playing: true }); expect(callbacks.size).toBe(1);
    clock.dispose(); clock.refreshFrameGate(gate);
    expect(callbacks.size).toBe(0);
    clock.attachFrameGate(gate); clock.toggle();
    expect(clock.getSnapshot()).toEqual({ timeUs: 0, playing: true }); expect(callbacks.size).toBe(1);
    clock.dispose();
  });

  it('ignores a canceled callback and keeps one RAF after synchronous frame acknowledgements', () => {
    const clock = new PlaybackClock(10_000_000, { numerator: 30, denominator: 1 });
    const gate = { constrainTime: (_from: number, requested: number) => requested, isFrameReady: () => true };
    clock.attachFrameGate(gate);
    clock.subscribe(() => clock.refreshFrameGate(gate));
    clock.toggle(); const canceled = [...callbacks.values()][0]; clock.pause(); clock.toggle();
    now = 34; canceled(34);
    expect(clock.getSnapshot().timeUs).toBe(0); expect(callbacks.size).toBe(1);
    advance(0);
    expect(clock.getSnapshot().timeUs).toBe(33333); expect(callbacks.size).toBe(1);
    clock.dispose(); expect(callbacks.size).toBe(0);
  });
});
