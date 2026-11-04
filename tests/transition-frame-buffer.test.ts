import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { TransitionFrameBuffer } from '../apps/desktop/src/components/transition-frame-buffer';

// Use the project's real Canvas implementation at the browser drawing boundary.
const { createCanvas } = createRequire(new URL('../packages/video/package.json', import.meta.url))('@napi-rs/canvas') as { createCanvas: (width: number, height: number) => HTMLCanvasElement };
const factory = () => createCanvas(1, 1);
const samples = [{ frame: 60, timeUs: 0 }, { frame: 61, timeUs: 16_667 }];

it('owns immutable snapshots instead of retaining the decoder canvas between samples', () => {
  const buffer = new TransitionFrameBuffer(samples, factory), source = createCanvas(8, 4), ctx = source.getContext('2d')!;
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 4);
  expect(buffer.capture(60, source)).toBe(true); expect(buffer.ready).toBe(false);
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 8, 4);
  expect(buffer.capture(61, source)).toBe(true); expect(buffer.ready).toBe(true);
  expect([...buffer.get(60)!.canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data]).toEqual([255, 0, 0, 255]);
  expect([...buffer.get(61)!.canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data]).toEqual([0, 0, 255, 255]);
  expect(buffer.get(60)!.canvas).not.toBe(source); expect(buffer.get(60)!.canvas).not.toBe(buffer.get(61)!.canvas);
});

it('requires the whole prefix and rejects duplicate, stale and out-of-order samples', () => {
  const buffer = new TransitionFrameBuffer(samples, factory), source = createCanvas(8, 4);
  expect(buffer.capture(61, source)).toBe(false); expect(buffer.capture(59, source)).toBe(false);
  expect(buffer.nextSample).toEqual(samples[0]); expect(buffer.capture(60, source)).toBe(true);
  expect(buffer.capture(60, source)).toBe(false); expect(buffer.nextSample).toEqual(samples[1]);
  expect(buffer.capture(61, source)).toBe(true); expect(buffer.nextSample).toBeUndefined();
  expect(buffer.ready).toBe(true); expect(buffer.capture(62, source)).toBe(false);
});

it('bounds retained pixels while preserving the presentation dimensions', () => {
  const prefix = Array.from({ length: 24 }, (_, frame) => ({ frame, timeUs: frame * 8333 }));
  const buffer = new TransitionFrameBuffer(prefix, factory, 1024), source = createCanvas(128, 72);
  prefix.forEach(sample => expect(buffer.capture(sample.frame, source)).toBe(true));
  expect(buffer.ready).toBe(true); expect(buffer.retainedPixels).toBeLessThanOrEqual(1024);
  expect(buffer.get(0)).toMatchObject({ width: 128, height: 72 });
  expect(buffer.get(0)!.canvas.width).toBeLessThan(128);
});

it('releases all owned images and permits a fresh capture after a StrictMode cleanup', () => {
  const buffer = new TransitionFrameBuffer(samples, factory), source = createCanvas(8, 4);
  buffer.capture(60, source); buffer.capture(61, source); expect(buffer.retainedPixels).toBe(64);
  buffer.clear(); expect(buffer.retainedPixels).toBe(0); expect(buffer.get(60)).toBeUndefined(); expect(buffer.ready).toBe(false);
  expect(buffer.nextSample).toEqual(samples[0]); expect(buffer.capture(60, source)).toBe(true);
});
