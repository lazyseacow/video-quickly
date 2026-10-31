import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';

if (process.env.GITHUB_ACTIONS !== 'true' || !['Windows','macOS'].includes(process.env.RUNNER_OS)) throw new Error('安装验收仅允许隔离 Windows/macOS CI 账号');
const [installation, dataDirectory] = process.argv.slice(2);
if (!installation || !dataDirectory) throw new Error('需要安装目录和隔离数据目录');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VIDEO_QUICKLY_DATA_DIR;
delete environment.VIDEO_QUICKLY_ELECTRON_USER_DATA;
delete environment.VIDEO_QUICKLY_DEV_URL;
const executablePath = process.platform === 'darwin' ? join(installation, 'Contents/MacOS/Video Quickly') : join(installation, 'video-quickly.exe');
const application = await _electron.launch({ executablePath, args: [], env: environment, timeout: 30_000 });
let runtimePid;
try {
  const window = await application.firstWindow();
  await expect(window.locator('.workspace-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => window.evaluate(() => window.videoQuickly.rpc('runtime.status')), { timeout: 20_000 }).toMatchObject({ state: 'ready' });
  const summary = await window.evaluate(() => window.videoQuickly.rpc('workspace.summary'));
  assert.equal(summary.system.dataDirectory.toLowerCase(), dataDirectory.toLowerCase(), 'Installed application must use its default Electron workspace');
  assert.equal(summary.system.mode, 'desktop');
  assert.equal(summary.system.ffmpegAvailable, true);
  const parent = application.process().pid;
  const execute = promisify(execFile);
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`]);
  const parsed = JSON.parse(stdout || '[]');
  const children = (Array.isArray(parsed) ? parsed : [parsed]).filter(child => child.CommandLine?.includes('runtime.mjs') && child.CommandLine.toLowerCase().includes(dataDirectory.toLowerCase()));
  assert.equal(children.length, 1, 'Installed Electron must own exactly one runtime');
  runtimePid = children[0].ProcessId;
  } else {
    const { stdout } = await execute('ps', ['-ax', '-o', 'pid=,ppid=,command=']);
    const children = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(row => row && Number(row[2]) === parent && row[3].includes('runtime.mjs') && row[3].includes(dataDirectory));
    assert.equal(children.length, 1, 'Installed Electron must own exactly one runtime');
    runtimePid = Number(children[0][1]);
  }
} finally { await application.close(); }
if (runtimePid) await expect.poll(() => { try { process.kill(runtimePid, 0); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(false);
console.log('安装后的 Electron 窗口、默认数据目录、预加载桥接、FFmpeg 和退出清理通过。');
