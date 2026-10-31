import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readResearchSource } from './research.js';

type TestWorker = EventEmitter & { terminate: ReturnType<typeof vi.fn> };
const boundary = vi.hoisted(() => ({ created: (_worker: TestWorker) => {} }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return { Worker: class extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough();
    terminate = vi.fn(async () => { this.stdout.destroy(); this.stderr.destroy(); return 1; });
    constructor() { super(); boundary.created(this); }
  } };
});

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(['error', 'exit', 'invalid-message', 'timeout'] as const)('settles a PDF worker %s and terminates it without leaving its timer active', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-pdf-worker-')); directories.push(directory);
  const path = join(directory, 'source.pdf'); await writeFile(path, '%PDF-test-only-boundary');
  const created = new Promise<TestWorker>(resolve => { boundary.created = resolve; });
  vi.useFakeTimers();
  const reading = readResearchSource({ path });
  const failure = expect(reading).rejects.toThrow(mode === 'timeout' ? '20 秒' : mode === 'error' ? 'worker initialization failed' : mode === 'exit' ? '提前结束' : '有效正文');
  const worker = await created;
  if (mode === 'error') worker.emit('error', new Error('worker initialization failed'));
  else if (mode === 'exit') worker.emit('exit', 0);
  else if (mode === 'invalid-message') worker.emit('message', { content: 4 });
  else await vi.advanceTimersByTimeAsync(20_000);
  await failure;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
