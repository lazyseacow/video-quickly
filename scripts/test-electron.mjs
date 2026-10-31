import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const fromDesktop = createRequire(join(desktop, 'package.json'));
const packaged = process.argv.includes('--packaged');
const artifacts = process.env.VIDEO_QUICKLY_ELECTRON_ARTIFACT_DIR ?? join(root, '.generated/electron-artifacts');
const reportPath = process.env.VIDEO_QUICKLY_ELECTRON_REPORT ?? join(root, '.generated/electron-results.json');
const fixture = await mkdtemp(join(tmpdir(), 'vq-electron-native-'));
const workspace = join(fixture, 'workspace');
const profile = join(fixture, 'profile');
const checks = {};
const errors = [];
let application;
let page;
let runtimePid;
let actualElectronVersion;
let distributionScope = packaged ? 'bundled-runtime-and-media' : 'source-desktop';
let credentialModel;
const testSecret = `isolated-electron-fixture-${randomUUID()}`;
let credentialRequests = 0;
const credentialServer = createServer((request, response) => {
  if (request.headers.authorization === `Bearer ${testSecret}`) credentialRequests++;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'isolated-native-fixture' }] }));
});
credentialServer.listen(0, '127.0.0.1');
await once(credentialServer, 'listening');
const environment = { ...process.env, VIDEO_QUICKLY_DATA_DIR: workspace, VIDEO_QUICKLY_ELECTRON_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VIDEO_QUICKLY_DEV_URL;
await mkdir(artifacts, { recursive: true });
await mkdir(workspace, { recursive: true });
function executablePath() {
  if (!packaged) return fromDesktop('electron');
  const directory = join(root, '.generated/electron-release');
  if (process.platform === 'win32') return join(directory, 'win-unpacked/video-quickly.exe');
  if (process.platform === 'darwin') return join(directory, `mac${process.arch === 'arm64' ? '-arm64' : ''}/Video Quickly.app/Contents/MacOS/Video Quickly`);
  return join(directory, 'linux-unpacked/video-quickly');
}
async function launch() {
  const executable = executablePath();
  assert.ok(existsSync(executable), 'Electron application must be built or installed before native testing');
  application = await _electron.launch({ executablePath: executable, args: packaged ? [] : [desktop], env: environment, timeout: 30_000 });
  actualElectronVersion = await application.evaluate(() => process.versions.electron);
  assert.equal(actualElectronVersion, fromDesktop('electron/package.json').version);
  if (packaged) {
    const resources = await application.evaluate(() => process.resourcesPath);
    const node = join(resources, 'sidecar', process.platform === 'win32' ? 'node.exe' : 'node');
    const media = join(resources, 'sidecar/media', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if ((await lstat(node)).isSymbolicLink() || !existsSync(media)) distributionScope = 'development-directory-bundle';
    if (process.platform === 'win32') assert.equal(distributionScope, 'bundled-runtime-and-media');
  }
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await expect(page).toHaveTitle(/Video Quickly/);
  await expect(page.locator('.workspace-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => rpc('runtime.status'), { timeout: 20_000 }).toMatchObject({ state: 'ready' });
  assert.equal(new URL(page.url()).protocol, 'video-quickly:');
  assert.equal(new URL(page.url()).hostname, 'app');
  return page;
}
function rpc(method, params = {}) { return page.evaluate(({ method, params }) => window.videoQuickly.rpc(method, params), { method, params }); }
async function findRuntime() {
  const parent = application.process().pid;
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`]);
    const parsed = JSON.parse(stdout || '[]');
    const children = Array.isArray(parsed) ? parsed : [parsed];
    const candidates = children.filter(value => value.CommandLine?.includes('runtime.mjs') && value.CommandLine.includes(workspace));
    assert.equal(candidates.length, 1, 'The desktop must own exactly one fixture runtime');
    return candidates[0].ProcessId;
  }
  const { stdout } = await execute('ps', ['-ax', '-o', 'pid=,ppid=,command=']);
  const candidates = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(value => value && Number(value[2]) === parent && value[3].includes('runtime.mjs') && value[3].includes(workspace));
  assert.equal(candidates.length, 1, 'The desktop must own exactly one fixture runtime');
  return Number(candidates[0][1]);
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function close() {
  if (!application) return;
  // Substitute only the native dialog's user decision. The production window
  // listener and quit ordering must remain responsible for approving departure.
  await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  await application.close(); application = undefined;
  if (runtimePid) await expect.poll(() => processAlive(runtimePid), { timeout: 10_000 }).toBe(false);
}
async function projectDocument(id) { return (await rpc('project.get', { projectId: id })).project; }
try {
  await launch();
  runtimePid = await findRuntime();
  const summary = await rpc('workspace.summary');
  assert.equal(summary.system.dataDirectory, workspace);
  assert.equal(summary.system.mode, 'desktop');
  const sandbox = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: typeof window.videoQuickly.rpc }));
  assert.deepEqual(sandbox, { require: 'undefined', process: 'undefined', bridge: 'function' });
  await assert.rejects(rpc('host.secret.get', { key: 'not-a-real-key' }), /桌面请求无效/);
  checks.nativeBridge = true;
  checks.sandbox = true;
  const senderDenied = await application.evaluate(async ({ BrowserWindow, app }) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + '/electron/preload.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false } });
    try {
      await other.loadURL('video-quickly://app/');
      return await other.webContents.executeJavaScript("window.videoQuickly.rpc('workspace.summary',{}).then(()=>false,()=>true)");
    } finally { other.destroy(); }
  });
  assert.equal(senderDenied, true); checks.senderBoundary = true;
  credentialModel = await rpc('model.save', { model: { name: '隔离系统凭据验收', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${credentialServer.address().port}/v1`, model: 'isolated-native-fixture', capabilities: ['text'], enabled: false }, secret: testSecret });
  assert.equal(credentialModel.hasSecret, true);
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 1);
  checks.nativeCredentialWriteRead = true;

  let project = await rpc('project.create', { title: 'Electron 原生功能验收', profile: { width: 320, height: 180, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain', previewScale: .5 } });
  project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'native-shot', title: '原生镜头', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } });
  await expect(page.getByRole('button', { name: `打开项目：${project.title}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  const title = page.getByLabel('镜头标题', { exact: true });
  await expect(title).toHaveValue('原生镜头');
  await title.fill('Electron 原生编辑');
  await page.getByRole('button', { name: '保存镜头', exact: true }).click();
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('Electron 原生编辑');
  await page.getByRole('button', { name: '撤销', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(title).toHaveValue('原生镜头');
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('原生镜头');
  await page.getByRole('button', { name: '重做', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(title).toHaveValue('Electron 原生编辑');
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('Electron 原生编辑');
  checks.editHistory = true;

  const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const video = join(fixture, '中文 原生媒体.mp4');
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  // Native dialogs themselves are OS UI; this substitutes only the user's
  // selection, while exercising real preload -> IPC -> dialog argument handling.
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, video);
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'file', title: '隔离文件选择验收', extensions: ['mp4'] })), video);
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'file', title: '取消选择验收' })), null);
  checks.dialogBridge = true;
  const asset = await rpc('asset.import', { projectId: project.id, shotId: 'native-shot', path: video, kind: 'video' });
  const media = await page.evaluate(async path => {
    const url = await window.videoQuickly.assetUrl(path);
    const response = await fetch(url, { headers: { Range: 'bytes=0-31' } });
    return { status: response.status, range: response.headers.get('Content-Range'), length: (await response.arrayBuffer()).byteLength };
  }, asset.path);
  assert.equal(media.status, 206); assert.equal(media.length, 32); assert.equal(media.range, `bytes 0-31/${asset.size}`);
  await assert.rejects(page.evaluate(path => window.videoQuickly.assetUrl(path), video), /工作区/);
  checks.mediaRange = true;
  checks.mediaBoundary = true;
  await expect.poll(() => page.locator('.preview-panel .scene-preview canvas').evaluate(canvas => { const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data; return pixel[0] < 50 && pixel[1] < 50 && pixel[2] > 180; }), { timeout: 10_000 }).toBe(true);
  checks.videoPreview = true;

  const exported = await rpc('render.export', { projectId: project.id });
  await expect.poll(async () => {
    const detail = await rpc('run.inspect', { runId: exported.runId });
    if (['failed', 'needs_attention'].includes(detail.run.status)) throw new Error(detail.run.error ?? 'Native export failed');
    return detail.run.status;
  }, { timeout: 60_000 }).toBe('succeeded');
  checks.actualExport = true;

  const before = await rpc('runtime.status');
  process.kill(runtimePid, 'SIGKILL');
  await expect.poll(() => rpc('runtime.status'), { timeout: 10_000 }).toMatchObject({ state: 'disconnected' });
  const resumed = await rpc('runtime.reconnect');
  assert.equal(resumed.state, 'ready'); assert.ok(resumed.generation > before.generation);
  runtimePid = await findRuntime();
  assert.equal((await projectDocument(project.id)).shots[0].title, 'Electron 原生编辑');
  checks.reconnect = true;

  const narration = page.getByLabel('旁白', { exact: true });
  await narration.fill('Electron 重启后恢复的未保存草稿');
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise((resolveDatabase, reject) => { const request = indexedDB.open('video-quickly-drafts', 1); request.onsuccess = () => resolveDatabase(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise(resolveResult => { const query = database.transaction('projects').objectStore('projects').getAll(); query.onsuccess = () => resolveResult(query.result.some(value => value.present.shots[0]?.narration === 'Electron 重启后恢复的未保存草稿')); }); }
    finally { database.close(); }
  }), { timeout: 10_000 }).toBe(true);
  await application.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__vqQuitDialogs = [];
    dialog.showMessageBoxSync = (_owner, options) => { globalThis.__vqQuitDialogs.push({ buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId }); return 0; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect.poll(() => application.evaluate(() => globalThis.__vqQuitDialogs.length)).toBe(1);
  assert.equal((await rpc('runtime.status')).state, 'ready');
  assert.equal((await projectDocument(project.id)).id, project.id);
  await expect(narration).toHaveValue('Electron 重启后恢复的未保存草稿');
  checks.cancelWindowClose = true;
  await application.evaluate(({ app }) => app.quit());
  await expect.poll(() => application.evaluate(() => globalThis.__vqQuitDialogs.length)).toBe(2);
  const quitDialogs = await application.evaluate(() => globalThis.__vqQuitDialogs);
  assert.deepEqual(quitDialogs, Array.from({ length: 2 }, () => ({ buttons: ['继续编辑', '离开'], defaultId: 0, cancelId: 0 })));
  assert.equal((await rpc('runtime.status')).state, 'ready');
  assert.equal((await projectDocument(project.id)).id, project.id);
  assert.equal(await findRuntime(), runtimePid);
  checks.cancelQuit = true;
  await page.screenshot({ path: join(artifacts, 'desktop-editor.png') });
  await close();
  checks.confirmedQuit = true;
  await launch(); runtimePid = await findRuntime();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('Electron 重启后恢复的未保存草稿');
  await expect(page.getByText('已恢复未保存的本地草稿，含撤销与重做历史。')).toBeVisible();
  checks.restartRecovery = true;
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 2);
  await rpc('model.delete', { modelId: credentialModel.id }); credentialModel = undefined;
  checks.nativeCredentialRestart = true;
  await page.screenshot({ path: join(artifacts, 'desktop-restored-draft.png') });
  assert.deepEqual(errors, [], 'Native renderer must have no application errors');
  checks.consoleHealth = true;
  await close();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: 'passed', platform: process.platform, architecture: process.arch, packaged, distributionScope, electron: actualElectronVersion, checks, nativeDialogs: 'selection-and-cancellation-substituted; OS UI requires manual verification', screenshots: ['desktop-editor.png', 'desktop-restored-draft.png'] }, null, 2));
  console.log('Electron 原生窗口、真实 IPC/Node、编辑历史、媒体 Range/导出、失联重连和重启草稿验收通过。');
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: 'failed', platform: process.platform, packaged, checks, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally {
  if (credentialModel && application) await rpc('model.delete', { modelId: credentialModel.id }).catch(() => {});
  credentialServer.closeAllConnections();
  await new Promise(resolveClose => credentialServer.close(resolveClose));
  if (application) await close().catch(() => { application?.process().kill('SIGKILL'); });
  if (runtimePid && processAlive(runtimePid)) process.kill(runtimePid, 'SIGKILL');
  await rm(fixture, { recursive: true, force: true });
}
