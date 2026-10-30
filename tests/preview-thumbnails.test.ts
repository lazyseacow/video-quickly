import { expect, it, vi } from 'vitest';
import { assetSchema } from '@video-quickly/contracts';
import { ThumbnailCache, type ThumbnailRequest } from '../apps/desktop/src/components/preview-thumbnails';

const asset = assetSchema.parse({ id: 'video', name: '视频', kind: 'video', path: 'D:/fixture/video.mp4', mimeType: 'video/mp4', sha256: 'a'.repeat(64), size: 100, version: 1, createdAt: '', provenance: 'fixture', active: true });
const input = (timeUs = 0): ThumbnailRequest => ({ asset, timeUs, width: 420, height: 236 });
const frame = (id: string, width = 10, height = 5) => ({ id, width, height });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
const read = <T extends { width: number; height: number }>(cache: ThumbnailCache<T>, value = input()) => cache.read(value, new AbortController().signal);

it('shares a source frame across consumers and does not cancel another visible consumer', async () => {
  const result = deferred<ReturnType<typeof frame>>(), decode = vi.fn((_input: ThumbnailRequest, _signal: AbortSignal) => result.promise), cache = new ThumbnailCache(decode);
  const first = new AbortController(), second = new AbortController();
  const a = cache.read(input(), first.signal), b = cache.read(input(), second.signal);
  const cancelled = expect(a).rejects.toMatchObject({ name: 'AbortError' }); first.abort(); await cancelled;
  expect(decode).toHaveBeenCalledTimes(1); expect(decode.mock.calls[0][1].aborted).toBe(false);
  const value = frame('shared'); result.resolve(value); expect(await b).toBe(value); expect(await read(cache)).toBe(value);
  expect(decode).toHaveBeenCalledTimes(1);
});

it('bounds concurrent decoders and keeps a canceled decoder slot until its work really settles', async () => {
  const jobs = [deferred<ReturnType<typeof frame>>(), deferred<ReturnType<typeof frame>>(), deferred<ReturnType<typeof frame>>()];
  let next = 0;
  const decode = vi.fn(() => jobs[next++].promise), cache = new ThumbnailCache(decode);
  const controller = new AbortController(), a = cache.read(input(1), controller.signal), b = read(cache, input(2)), c = read(cache, input(3));
  expect(decode).toHaveBeenCalledTimes(2);
  const canceled = expect(a).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await canceled;
  expect(decode).toHaveBeenCalledTimes(2);
  jobs[0].resolve(frame('late canceled frame')); await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
  jobs[1].resolve(frame('second')); jobs[2].resolve(frame('third'));
  expect((await b).id).toBe('second'); expect((await c).id).toBe('third');
});

it('removes offscreen queued work before it allocates a decoder', async () => {
  const first = deferred<ReturnType<typeof frame>>(), decode = vi.fn(() => first.promise);
  const cache = new ThumbnailCache(decode, { concurrency: 1, frames: 2, pixels: 1000 });
  const a = read(cache), controller = new AbortController(), b = cache.read(input(1), controller.signal);
  const canceled = expect(b).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await canceled;
  first.resolve(frame('first')); await a;
  expect(decode).toHaveBeenCalledTimes(1);
});

it('does not cache decode failures and retries an explicitly requested frame', async () => {
  const decode = vi.fn(async () => frame('retry')).mockRejectedValueOnce(new Error('decode failed'));
  const cache = new ThumbnailCache<ReturnType<typeof frame>>(decode);
  await expect(read(cache)).rejects.toThrow('decode failed'); expect((await read(cache)).id).toBe('retry'); expect(decode).toHaveBeenCalledTimes(2);
});

it('separates asset identity, version, hash, path, source sample and frame size', async () => {
  let decoded = 0;
  const decode = vi.fn(async () => frame(String(++decoded))), cache = new ThumbnailCache(decode);
  const original = await read(cache);
  for (const changed of [
    { ...input(), asset: { ...asset, id: 'other' } }, { ...input(), asset: { ...asset, version: 2 } },
    { ...input(), asset: { ...asset, sha256: 'b'.repeat(64) } }, { ...input(), asset: { ...asset, path: 'D:/other.mp4' } },
    input(33333), { ...input(), width: 236, height: 420 },
  ]) expect(await read(cache, changed)).not.toBe(original);
  expect(await read(cache)).toBe(original); expect(decode).toHaveBeenCalledTimes(7);
});

it('evicts least recently used frames by both count and actual pixel budget', async () => {
  const decode = vi.fn(async (value: ThumbnailRequest) => frame(String(value.timeUs)));
  const count = new ThumbnailCache(decode, { concurrency: 2, frames: 2, pixels: 1000 });
  const a = await read(count, input(1)); await read(count, input(2)); await read(count, input(1)); await read(count, input(3));
  expect(await read(count, input(1))).toBe(a); expect(decode).toHaveBeenCalledTimes(3);
  await read(count, input(2)); expect(decode).toHaveBeenCalledTimes(4);
  const pixels = new ThumbnailCache(decode, { concurrency: 2, frames: 10, pixels: 70 });
  await read(pixels, input(1)); await read(pixels, input(2)); await read(pixels, input(1)); expect(decode).toHaveBeenCalledTimes(7);
  const oversizedDecode = vi.fn(async () => frame('large', 20, 20)), oversized = new ThumbnailCache(oversizedDecode, { concurrency: 2, frames: 10, pixels: 70 });
  await read(oversized); await read(oversized); expect(oversizedDecode).toHaveBeenCalledTimes(2);
});

it('cannot let a late canceled request delete or overwrite its newer replacement', async () => {
  const old = deferred<ReturnType<typeof frame>>(), fresh = deferred<ReturnType<typeof frame>>();
  const decode = vi.fn(() => fresh.promise).mockReturnValueOnce(old.promise);
  const cache = new ThumbnailCache<ReturnType<typeof frame>>(decode, { concurrency: 1, frames: 2, pixels: 1000 });
  const controller = new AbortController(), first = cache.read(input(), controller.signal);
  const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await canceled;
  const next = read(cache); old.resolve(frame('obsolete')); await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  const shared = read(cache), value = frame('newer'); fresh.resolve(value);
  expect(await next).toBe(value); expect(await shared).toBe(value); expect(await read(cache)).toBe(value); expect(decode).toHaveBeenCalledTimes(2);
});
