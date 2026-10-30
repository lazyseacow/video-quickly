import { expect, it } from 'vitest';
import { createRefreshQueue } from '../apps/desktop/src/lib/refresh-queue';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

it('delivers the current complete read and merges overlapping fresh requests into one later pass', async () => {
  const first = deferred<number>(), second = deferred<number>(), entered = deferred<void>(); let calls = 0, simultaneous = 0, maximum = 0;
  const refresh = createRefreshQueue(async () => {
    const number = ++calls; simultaneous++; maximum = Math.max(maximum, simultaneous);
    try { if (number === 2) entered.resolve(); return await (number === 1 ? first.promise : second.promise); }
    finally { simultaneous--; }
  });
  const current = refresh(), later = Array.from({ length: 100 }, () => refresh());
  expect(calls).toBe(1); expect(later.every(value => value === later[0])).toBe(true);
  first.resolve(1); expect(await current).toBe(1); await entered.promise;
  expect(calls).toBe(2); expect(maximum).toBe(1);
  second.resolve(2); expect(await Promise.all(later)).toEqual(Array.from({ length: 100 }, () => 2));
});

it('does not retry a failed read without another request and releases the queue for explicit recovery', async () => {
  let calls = 0, idle = 0;
  const refresh = createRefreshQueue(async () => { calls++; if (calls === 1) throw new Error('read failed'); return 'recovered'; }, () => { idle++; });
  await expect(refresh()).rejects.toThrow('read failed'); expect(calls).toBe(1); expect(idle).toBe(1);
  await expect(refresh()).resolves.toBe('recovered'); expect(calls).toBe(2); expect(idle).toBe(2);
});

it('honors an already queued read after the preceding read fails', async () => {
  const first = deferred<string>(); let calls = 0;
  const refresh = createRefreshQueue(async () => { calls++; return calls === 1 ? first.promise : 'next request'; });
  const failed = refresh(), next = refresh(); const observed = expect(failed).rejects.toThrow('read failed');
  first.reject(new Error('read failed')); await observed;
  await expect(next).resolves.toBe('next request'); expect(calls).toBe(2);
});
