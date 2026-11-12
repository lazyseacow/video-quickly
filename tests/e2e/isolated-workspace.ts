import { fork, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test as base } from '@playwright/test';

const desktop = resolve(import.meta.dirname, '../../src');
type Message = Record<string, unknown>;
function message(child: ChildProcess, type: string, timeout: number): Promise<Message> {
  return new Promise((done, reject) => {
    const clean = () => { clearTimeout(timer); child.off('message', received); child.off('error', failed); child.off('exit', exited); };
    const failed = (error: Error) => { clean(); reject(error); };
    const exited = (code: number | null, signal: string | null) => failed(new Error(`隔离预览在 ${type} 前退出：${code ?? signal}`));
    const received = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'failed') { failed(new Error('message' in value ? String(value.message) : '隔离预览启动失败')); return; }
      if (value.type === type) { clean(); done(value as Message); }
    };
    const timer = setTimeout(() => failed(new Error(`等待隔离预览 ${type} 超时。`)), timeout);
    child.on('message', received); child.once('error', failed); child.once('exit', exited);
  });
}
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('隔离预览未退出。')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Fault fixtures own a real preview/runtime, filesystem and HTTP origin for each test. */
export const test = base.extend<{ isolatedWorkspace: { directory: string; origin: string } }>({
  isolatedWorkspace: [async ({}, use, info) => {
    const directory = await mkdtemp(join(tmpdir(), 'vq-isolated-browser-')), canonical = await realpath(directory), parent = await realpath(tmpdir()), owned = await lstat(directory, { bigint: true });
    const difference = relative(parent, canonical);
    if (difference === '..' || difference.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(difference)) throw new Error('隔离目录不在系统临时目录内。');
    // Each writer owns its output; a child must never truncate the main preview's diagnostics.
    const diagnostics = process.env.VIDEO_QUICKLY_RPC_DIAGNOSTICS ? { VIDEO_QUICKLY_RPC_DIAGNOSTICS: info.outputPath('browser-rpc-diagnostics.jsonl') } : {};
    const child = fork(join(desktop, 'dev/preview-e2e.ts'), [], { cwd: desktop, execArgv: ['--import', 'tsx'], env: { ...process.env, ...diagnostics, VIDEO_QUICKLY_DATA_DIR: directory, VIDEO_QUICKLY_PORT: '0', VIDEO_QUICKLY_NATIVE_DESKTOP: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '', closed = false;
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-16_000); });
    const exit = new Promise<{ code: number | null; signal: string | null }>(done => child.once('close', (code, signal) => { closed = true; done({ code, signal }); }));
    try {
      const ready = await message(child, 'ready', 30_000);
      if (typeof ready.url !== 'string' || ready.directory !== resolve(directory)) throw new Error('隔离预览返回了其他工作区。');
      const url = new URL(ready.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('隔离预览监听地址无效。');
      const response = await fetch(new URL('/__desktop_rpc', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin }, body: JSON.stringify({ method: 'workspace.summary' }), signal: AbortSignal.timeout(3000) });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== 'object' || !('result' in payload) || !payload.result || typeof payload.result !== 'object' || !('system' in payload.result) || !payload.result.system || typeof payload.result.system !== 'object' || !('dataDirectory' in payload.result.system) || payload.result.system.dataDirectory !== resolve(directory)) throw new Error('隔离预览未连接自己的工作区。');
      await use({ directory, origin: url.origin });
    } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`, { cause: error }); }
    finally {
      let failure: unknown;
      try {
        if (!closed) {
          const acknowledged = message(child, 'closed', 20_000);
          child.send({ type: 'shutdown' }); await acknowledged;
        }
        const result = await bounded(exit, 5000);
        if (result.code !== 0) throw new Error(`隔离预览异常退出：${result.code ?? result.signal}`);
      } catch (error) {
        failure = error;
        if (!closed) child.kill('SIGTERM');
        try { await bounded(exit, 5000); } catch { child.kill('SIGKILL'); await bounded(exit, 5000); }
      } finally {
        // Delete only the exact directory this fixture created, after the child has released SQLite.
        const current = await lstat(directory, { bigint: true });
        if (!closed || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino || await realpath(directory) !== canonical) throw new Error('隔离目录归属或进程状态已变化，拒绝清理。');
        await rm(directory, { recursive: true, force: true });
      }
      if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}\n${output}`, { cause: failure });
    }
  }, { timeout: 60_000 }],
  baseURL: async ({ isolatedWorkspace }, use) => { await use(isolatedWorkspace.origin); },
  storageState: async ({ isolatedWorkspace }, use) => { await use({ cookies: [], origins: [{ origin: isolatedWorkspace.origin, localStorage: [{ name: 'vq-theme', value: 'dark' }, { name: 'vq-onboarding-v1', value: 'done' }] }] }); },
});
