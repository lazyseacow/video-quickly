import { expect, it, vi } from 'vitest';
import { findElectronRuntime } from '../scripts/electron-runtime-process.mjs';

const workspace = 'C:\\Users\\Fixture\\中文 workspace';
const application = () => ({ process: () => ({ pid: 100 }), evaluate: vi.fn(async () => 200) });
const row = (patch = {}) => ({ ProcessId: 300, ParentProcessId: 200, Name: 'node.exe', CommandLine: '"C:\\App with spaces\\node.exe" "C:\\App with spaces\\runtime.mjs" --data-dir "C:\\Users\\Fixture\\中文 workspace" --ffmpeg "C:\\App with spaces\\ffmpeg.exe"', ...patch });
const response = (rows: unknown, stderr = '') => ({ stdout: JSON.stringify(rows), stderr });

it('uses the real Electron main PID and keeps launcher PID and owned CIM fields observable', async () => {
  const app = application(), run = vi.fn(async () => response(row())), onDiagnostics = vi.fn();
  expect(await findElectronRuntime(app, workspace, { platform: 'win32', run, timeoutMs: 0, onDiagnostics })).toBe(300);
  expect(app.evaluate).toHaveBeenCalledOnce();
  expect(run.mock.calls[0][1].at(-1)).toContain('ParentProcessId=200');
  expect(run.mock.calls[0][1].at(-1)).toContain('ProcessId,ParentProcessId,Name,CommandLine');
  expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ mainPid: 200, launcherPid: 100, expectedWorkspace: workspace, attempts: [expect.objectContaining({ ownedRows: [row()] })] }));
});

it('matches Windows case and slash variants without changing the workspace boundary', async () => {
  const run = vi.fn(async () => response(row({ CommandLine: '"D:/Sidecar/RUNTIME.MJS" --data-dir "c:/users/FIXTURE/中文 workspace"' })));
  expect(await findElectronRuntime(application(), workspace, { platform: 'win32', run, timeoutMs: 0 })).toBe(300);
});

it('matches UNC workspace arguments using either Windows separator form', async () => {
  const run = vi.fn(async () => response(row({ CommandLine: 'D:/Sidecar/runtime.mjs --data-dir "//SERVER/share/中文 workspace"' })));
  expect(await findElectronRuntime(application(), '\\\\server\\share\\中文 workspace', { platform: 'win32', run, timeoutMs: 0 })).toBe(300);
});

it.each([
  row({ ParentProcessId: 100 }),
  row({ CommandLine: 'C:\\App\\runtime.mjs --data-dir C:\\Other' }),
  row({ CommandLine: 'C:\\App\\runtime.mjs --data-dir "C:\\Users\\Fixture\\中文 workspace-sibling"' }),
  row({ CommandLine: 'C:\\App\\not-runtime.mjs --data-dir "C:\\Users\\Fixture\\中文 workspace"' }),
  row({ Name: 'other.exe' }),
  row({ CommandLine: null }),
])('rejects an unrelated or incomplete child: %j', async candidate => {
  const onDiagnostics = vi.fn();
  await expect(findElectronRuntime(application(), workspace, { platform: 'win32', run: async () => response(candidate), timeoutMs: 0, onDiagnostics })).rejects.toThrow('found 0');
  expect(onDiagnostics).toHaveBeenCalledOnce();
});

it('rejects two matching owned runtimes instead of choosing the first', async () => {
  await expect(findElectronRuntime(application(), workspace, { platform: 'win32', run: async () => response([row(), row({ ProcessId: 301 })]), timeoutMs: 0 })).rejects.toThrow('found 2');
});

it('waits within its deadline for an owned process to become visible in CIM', async () => {
  const run = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValue(response([row()]));
  expect(await findElectronRuntime(application(), workspace, { platform: 'win32', run, timeoutMs: 100, intervalMs: 1 })).toBe(300);
  expect(run).toHaveBeenCalledTimes(2);
});

it('preserves raw query errors and both PIDs when its bounded lookup fails', async () => {
  const onDiagnostics = vi.fn(), run = vi.fn(async () => { throw Object.assign(new Error('CIM unavailable'), { stdout: 'owned query output', stderr: 'fixture query failure' }); });
  await expect(findElectronRuntime(application(), workspace, { platform: 'win32', run, timeoutMs: 0, onDiagnostics })).rejects.toThrow('exactly one');
  expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ mainPid: 200, launcherPid: 100, attempts: [expect.objectContaining({ stdout: 'owned query output', stderr: 'fixture query failure', error: 'CIM unavailable' })] }));
});

it('stops retrying an absent owned runtime at its deadline and saves the last observed rows', async () => {
  const onDiagnostics = vi.fn(), run = vi.fn(async () => response([]));
  await expect(findElectronRuntime(application(), workspace, { platform: 'win32', run, timeoutMs: 10, intervalMs: 2, onDiagnostics })).rejects.toThrow('found 0');
  const diagnostics = onDiagnostics.mock.calls[0][0];
  expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(10);
  expect(diagnostics.attempts.length).toBeGreaterThanOrEqual(1);
  expect(diagnostics.attempts.at(-1)).toMatchObject({ ownedRows: [], matchingPids: [], stdout: '[]' });
});

it('records malformed JSON rather than treating it as an empty successful query', async () => {
  const onDiagnostics = vi.fn();
  await expect(findElectronRuntime(application(), workspace, { platform: 'win32', run: async () => ({ stdout: 'invalid json', stderr: 'query diagnostics' }), timeoutMs: 0, onDiagnostics })).rejects.toThrow('found 0');
  expect(onDiagnostics.mock.calls[0][0].attempts[0]).toMatchObject({ stdout: 'invalid json', stderr: 'query diagnostics', error: expect.any(String) });
});

it('keeps POSIX discovery owned by the main PID and excludes unrelated ps rows from diagnostics', async () => {
  const onDiagnostics = vi.fn();
  const run = vi.fn(async () => ({ stdout: '300 200 /tmp/App with spaces/node /tmp/App with spaces/runtime.mjs --data-dir /tmp/中文 workspace --ffmpeg /tmp/ffmpeg\n301 100 /unrelated/private-process', stderr: '' }));
  expect(await findElectronRuntime(application(), '/tmp/中文 workspace', { platform: 'darwin', run, timeoutMs: 0, onDiagnostics })).toBe(300);
  expect(onDiagnostics.mock.calls[0][0].attempts[0].stdout).not.toContain('private-process');
});
