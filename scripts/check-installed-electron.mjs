import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { _electron, expect } from '@playwright/test';
import { findElectronRuntime } from './electron-runtime-process.mjs';

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
  runtimePid = await findElectronRuntime(application, dataDirectory, { onDiagnostics: async diagnostics => {
    const path = resolve('.generated/electron-artifacts/installed-runtime-process-diagnostics.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(diagnostics, null, 2));
  } });
} finally { await application.close(); }
if (runtimePid) await expect.poll(() => { try { process.kill(runtimePid, 0); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(false);
console.log('安装后的 Electron 窗口、默认数据目录、预加载桥接、FFmpeg 和退出清理通过。');
