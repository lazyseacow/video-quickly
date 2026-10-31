import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readResearchSource } from './research.js';

type TestChild = EventEmitter & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
const boundary = vi.hoisted(() => ({ created: (_child: TestChild) => {} }));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return { fork: vi.fn(() => {
    class Child extends EventEmitter {
      stdout = new PassThrough(); stderr = new PassThrough();
      send = vi.fn((_bytes: unknown, callback: (error: Error | null) => void) => callback(null));
      kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null, 'SIGKILL')); return true; });
    }
    const child = new Child(); boundary.created(child); return child;
  }) };
});

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(['error', 'exit', 'invalid-message', 'timeout', 'message-then-crash'] as const)('settles PDF child %s after its process closes and clears its timer', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-pdf-process-')); directories.push(directory);
  const path = join(directory, 'source.pdf'); await writeFile(path, '%PDF-test-only-boundary');
  const created = new Promise<TestChild>(resolve => { boundary.created = resolve; });
  vi.useFakeTimers();
  const reading = readResearchSource({ path });
  const failure = expect(reading).rejects.toThrow(mode === 'timeout' ? '20 秒' : mode === 'error' ? 'process initialization failed' : mode === 'exit' || mode === 'message-then-crash' ? '异常结束' : '有效正文');
  const child = await created;
  if (mode === 'error') child.emit('error', new Error('process initialization failed'));
  else if (mode === 'exit') child.emit('close', 3221225477, null);
  else if (mode === 'invalid-message') { child.emit('message', { content: 4 }); child.emit('close', 0, null); }
  else if (mode === 'message-then-crash') { child.emit('message', { content: '实际原文已返回，但原生析构崩溃。' }); child.emit('close', 3221225477, null); }
  else await vi.advanceTimersByTimeAsync(20_000);
  await failure;
  expect(child.kill).toHaveBeenCalledTimes(mode === 'timeout' || mode === 'error' ? 1 : 0);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not accept valid PDF text until the child has exited successfully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-pdf-process-')); directories.push(directory);
  const path = join(directory, 'source.pdf'); await writeFile(path, '%PDF-test-only-boundary');
  const created = new Promise<TestChild>(resolve => { boundary.created = resolve; });
  const reading = readResearchSource({ path });
  const child = await created;
  let settled = false; void reading.then(() => { settled = true; });
  child.emit('message', { content: '真实的提取正文。' });
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('close', 0, null);
  expect((await reading).content).toBe('真实的提取正文。');
  expect(child.kill).not.toHaveBeenCalled();
});
