import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
const workspace = join(fixture, '中文 workspace');
const profile = join(fixture, '中文 Chromium profile');
const checks = {};
const errors = [];
let application;
let page;
let runtimePid;
let actualElectronVersion;
let distributionScope = packaged ? 'unverified-package' : 'source-desktop';
let fixtureFfmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
let credentialModel;
const testSecret = `isolated-electron-fixture-${randomUUID()}`;
let expectedSecret = testSecret;
const credentialReferences = new Set();
let credentialRequests = 0;
const credentialServer = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${expectedSecret}`) { response.writeHead(401); response.end(); return; }
  credentialRequests++;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'isolated-native-fixture' }] }));
});
credentialServer.listen(0, '127.0.0.1');
await once(credentialServer, 'listening');
const environment = { ...process.env, VIDEO_QUICKLY_DATA_DIR: workspace, VIDEO_QUICKLY_ELECTRON_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VIDEO_QUICKLY_DEV_URL;
if (packaged) {
  for (const key of ['VIDEO_QUICKLY_FFMPEG', 'VIDEO_QUICKLY_FFPROBE', 'VIDEO_QUICKLY_MEDIA_DIR']) delete environment[key];
  if (process.platform === 'darwin') environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
}
await mkdir(artifacts, { recursive: true });
await mkdir(workspace, { recursive: true });
function executablePath() {
  if (process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE) {
    assert.equal(packaged, true, 'An executable override is only valid for packaged acceptance');
    assert.ok(isAbsolute(process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE), 'The packaged test executable must use an absolute path');
    return process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE;
  }
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
    const sidecar = join(resources, 'sidecar'), suffix = process.platform === 'win32' ? '.exe' : '';
    const node = join(sidecar, `node${suffix}`), media = join(sidecar, 'media');
    for (const tool of [node, join(media, `ffmpeg${suffix}`), join(media, `ffprobe${suffix}`)]) {
      const metadata = await lstat(tool);
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Packaged Node, FFmpeg and FFprobe must be ordinary bundled files');
    }
    const info = JSON.parse(await readFile(join(sidecar, 'runtime-info.json'), 'utf8'));
    const provenance = JSON.parse(await readFile(join(media, 'provenance.json'), 'utf8'));
    assert.equal(info.portability, 'bundled'); assert.equal(info.platform, process.platform); assert.equal(info.architecture, process.arch);
    assert.equal(provenance.verified, true);
    assert.equal((await execute(node, ['--version'], { env: environment })).stdout.trim(), info.nodeVersion);
    if (process.platform === 'darwin') {
      assert.equal(info.nodeProvenance?.verified, true);
      assert.equal(provenance.platform, 'darwin'); assert.equal(provenance.architecture, process.arch);
    }
    distributionScope = 'bundled-runtime-and-media';
    fixtureFfmpeg = join(media, `ffmpeg${suffix}`);
    checks.bundledTools = true;
  }
  observePage(await application.firstWindow());
  await expect(page).toHaveTitle(/Video Quickly/);
  await expect(page.locator('.workspace-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => rpc('runtime.status'), { timeout: 20_000 }).toMatchObject({ state: 'ready' });
  assert.equal(new URL(page.url()).protocol, 'video-quickly:');
  assert.equal(new URL(page.url()).hostname, 'app');
  return page;
}
function observePage(next) {
  page = next;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
}
function rpc(method, params = {}) { return page.evaluate(({ method, params }) => window.videoQuickly.rpc(method, params), { method, params }); }
async function findRuntime() {
  const parent = application.process().pid;
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`]);
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
async function close(expectedConfirmations) {
  if (!application) return;
  // Substitute only the native dialog's user decision. The production window
  // listener and quit ordering must remain responsible for approving departure.
  const confirmationLog = join(fixture, `quit-${randomUUID()}.jsonl`);
  await application.evaluate(({ dialog }, path) => {
    dialog.showMessageBoxSync = (_owner, options) => { process.getBuiltinModule('fs').appendFileSync(path, JSON.stringify({ buttons: options.buttons }) + '\n'); return 1; };
  }, confirmationLog);
  await application.close(); application = undefined;
  if (runtimePid) await expect.poll(() => processAlive(runtimePid), { timeout: 10_000 }).toBe(false);
  if (expectedConfirmations !== undefined) {
    const decisions = await readFile(confirmationLog, 'utf8').then(value => value.trim().split('\n').filter(Boolean), error => { if (error.code === 'ENOENT') return []; throw error; });
    assert.equal(decisions.length, expectedConfirmations, 'One departure must not ask for the same unsaved edits twice');
  }
}
async function projectDocument(id) { return (await rpc('project.get', { projectId: id })).project; }
async function cleanupCredentialReferences() {
  if (!credentialReferences.size || !application) return;
  const absent = await application.evaluate(async ({ app }, references) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { AsyncEntry } = load('@napi-rs/keyring');
    for (const reference of references) {
      const entry = new AsyncEntry('video-quickly-electron', reference);
      await entry.deleteCredential();
      if (await entry.getPassword() !== null) return false;
    }
    return true;
  }, [...credentialReferences]);
  assert.equal(absent, true, 'Every credential created by this isolated fixture must be removed');
  credentialReferences.clear();
}
try {
  await launch();
  runtimePid = await findRuntime();
  const summary = await rpc('workspace.summary');
  assert.equal(summary.system.dataDirectory, workspace);
  assert.equal(summary.system.mode, 'desktop');
  assert.equal(await page.evaluate(() => window.videoQuickly.platform), process.platform);
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
  credentialReferences.add(credentialModel.credentialRef);
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
  const undo = page.getByRole('button', { name: '撤销', exact: true }), redo = page.getByRole('button', { name: '重做', exact: true });
  // A committed RPC may still be awaiting its reply in the renderer. History
  // shortcuts must wait until the UI leaves that saving state and owns focus.
  await expect(undo).toBeEnabled(); await undo.focus(); await expect(undo).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(title).toHaveValue('原生镜头');
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('原生镜头');
  await expect(redo).toBeEnabled(); await redo.focus(); await expect(redo).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(title).toHaveValue('Electron 原生编辑');
  await expect.poll(async () => (await projectDocument(project.id)).shots[0].title).toBe('Electron 原生编辑');
  checks.editHistory = true;

  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveAttribute('title', new RegExp(`${process.platform === 'darwin' ? '⌘' : 'Ctrl'} Z`));
  checks.platformShortcutHints = true;
  await page.getByRole('button', { name: '导入画面', exact: true }).click();
  const importDialog = page.getByRole('dialog'), pathInput = importDialog.getByRole('textbox', { name: '图片文件路径', exact: true });
  await pathInput.fill('native-input');
  await pathInput.press('End'); await pathInput.pressSequentially('-edited');
  await pathInput.press('ControlOrMeta+z'); await expect(pathInput).toHaveValue('native-input');
  await pathInput.press(process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z'); await expect(pathInput).toHaveValue('native-input-edited');
  await pathInput.press('ControlOrMeta+a');
  assert.deepEqual(await pathInput.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 'native-input-edited'.length]);
  await importDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await projectDocument(project.id)).shots[0].title, 'Electron 原生编辑');
  checks.nativeTextEditing = true;

  const video = join(fixture, '中文 原生媒体.mp4');
  await execute(fixtureFfmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], { env: packaged ? environment : process.env });
  // Native dialogs themselves are OS UI; this substitutes only the user's
  // selection, while exercising real preload -> IPC -> dialog argument handling.
  await application.evaluate(({ dialog }, path) => {
    globalThis.__vqFileDialogs = [];
    dialog.showOpenDialog = async (_owner, options) => { globalThis.__vqFileDialogs.push(options); return { canceled: false, filePaths: [path] }; };
  }, video);
  assert.equal(await page.evaluate(path => window.videoQuickly.pickPath({ mode: 'file', title: '隔离文件选择验收', defaultPath: path, extensions: ['mp4'] }), video), video);
  const fileOptions = await application.evaluate(() => globalThis.__vqFileDialogs[0]);
  assert.deepEqual(fileOptions, { title: '隔离文件选择验收', defaultPath: video, filters: [{ name: '素材文件', extensions: ['mp4'] }], properties: ['openFile'] });
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'file', title: '取消选择验收' })), null);
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (_owner, options) => { globalThis.__vqFileDialogs.push(options); return { canceled: false, filePaths: [directory] }; };
  }, fixture);
  assert.equal(await page.evaluate(path => window.videoQuickly.pickPath({ mode: 'directory', title: '选择目录验收', defaultPath: path }), fixture), fixture);
  const directoryOptions = await application.evaluate(() => globalThis.__vqFileDialogs.at(-1));
  assert.deepEqual(directoryOptions, { title: '选择目录验收', defaultPath: fixture, properties: ['openDirectory', 'createDirectory'] });
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'directory', title: '取消目录验收' })), null);
  const destination = join(fixture, '中文 导出成片.mp4');
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async (_owner, options) => { globalThis.__vqFileDialogs.push(options); return { canceled: false, filePath: path }; };
  }, destination);
  assert.equal(await page.evaluate(path => window.videoQuickly.pickPath({ mode: 'save', title: '保存文件验收', defaultPath: path, extensions: ['mp4'] }), destination), destination);
  assert.deepEqual(await application.evaluate(() => globalThis.__vqFileDialogs.at(-1)), { title: '保存文件验收', defaultPath: destination, filters: [{ name: '导出文件', extensions: ['mp4'] }] });
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.equal(await page.evaluate(() => window.videoQuickly.pickPath({ mode: 'save', title: '取消保存验收' })), null);
  await application.evaluate(({ shell }) => { globalThis.__vqRevealed = []; shell.showItemInFolder = path => { globalThis.__vqRevealed.push(path); }; });
  await page.evaluate(async ({ file, directory }) => { await window.videoQuickly.revealFile(file); await window.videoQuickly.revealFile(directory); }, { file: video, directory: fixture });
  assert.deepEqual(await application.evaluate(() => globalThis.__vqRevealed), [video, fixture]);
  await assert.rejects(page.evaluate(path => window.videoQuickly.revealFile(path), join(fixture, 'missing.mp4')));
  checks.dialogBridge = true;
  checks.directoryAndSaveDialogs = true;
  checks.revealBridge = true;
  const asset = await rpc('asset.import', { projectId: project.id, shotId: 'native-shot', path: video, kind: 'video' });
  const media = await page.evaluate(async ({ path, size }) => {
    const url = await window.videoQuickly.assetUrl(path);
    const read = async (range, method = 'GET') => {
      const response = await fetch(url, { method, headers: range ? { Range: range } : {} });
      return { status: response.status, range: response.headers.get('Content-Range'), length: response.headers.get('Content-Length'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    };
    return { first: await read('bytes=0-31'), suffix: await read('bytes=-16'), tail: await read(`bytes=${size - 17}-`), head: await read(undefined, 'HEAD') };
  }, { path: asset.path, size: asset.size });
  const invalidMedia = await application.evaluate(async ({ net }, { path, size, outside }) => {
    const url = `video-quickly://app/__asset?path=${encodeURIComponent(path)}`;
    const invalid = await net.fetch(url, { headers: { Range: `bytes=${size}-` } }), write = await net.fetch(url, { method: 'POST' });
    const escaped = await net.fetch(`video-quickly://app/__asset?path=${encodeURIComponent(outside)}`);
    return { status: invalid.status, range: invalid.headers.get('Content-Range'), writeStatus: write.status, escapedStatus: escaped.status };
  }, { path: asset.path, size: asset.size, outside: video });
  const importedBytes = await readFile(asset.path);
  assert.equal(media.first.status, 206); assert.equal(media.first.range, `bytes 0-31/${asset.size}`); assert.deepEqual(media.first.bytes, [...importedBytes.subarray(0, 32)]);
  assert.equal(media.suffix.status, 206); assert.deepEqual(media.suffix.bytes, [...importedBytes.subarray(-16)]);
  assert.equal(media.tail.status, 206); assert.deepEqual(media.tail.bytes, [...importedBytes.subarray(-17)]);
  assert.equal(media.head.status, 200); assert.equal(media.head.length, String(asset.size)); assert.deepEqual(media.head.bytes, []);
  assert.equal(invalidMedia.status, 416); assert.equal(invalidMedia.range, `bytes */${asset.size}`); assert.equal(invalidMedia.writeStatus, 405); assert.equal(invalidMedia.escapedStatus, 404);
  await assert.rejects(page.evaluate(path => window.videoQuickly.assetUrl(path), video), /工作区/);
  await symlink(fixture, join(workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(page.evaluate(path => window.videoQuickly.assetUrl(path), join(workspace, 'outside-link', '中文 原生媒体.mp4')), /工作区/);
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
  if (process.platform === 'darwin') {
    const retainedPid = runtimePid, retainedGeneration = (await rpc('runtime.status')).generation;
    for (const activation of ['activate', 'second-instance']) {
      await application.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBoxSync = () => 1; BrowserWindow.getAllWindows()[0].close(); });
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
      assert.equal(processAlive(retainedPid), true, 'Closing the last Mac window must leave its runtime available');
      const opened = application.waitForEvent('window');
      if (activation === 'activate') await application.evaluate(({ app }) => app.emit('activate'));
      else await execute(executablePath(), packaged ? [] : [desktop], { env: environment, timeout: 20_000 });
      observePage(await opened);
      await expect(page.locator('.workspace-shell')).toBeVisible();
      await expect.poll(() => rpc('runtime.status')).toMatchObject({ state: 'ready', generation: retainedGeneration });
      assert.equal(await findRuntime(), retainedPid, `${activation} must reuse exactly one runtime`);
      await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
      await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('Electron 重启后恢复的未保存草稿');
    }
    checks.macWindowReopen = true;
    checks.macSecondInstance = true;
  }
  await page.screenshot({ path: join(artifacts, 'desktop-editor.png') });
  await close(1);
  checks.confirmedQuit = true;
  await launch(); runtimePid = await findRuntime();
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('旁白', { exact: true })).toHaveValue('Electron 重启后恢复的未保存草稿');
  await expect(page.getByText('已恢复未保存的本地草稿，含撤销与重做历史。')).toBeVisible();
  checks.restartRecovery = true;
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 2);
  expectedSecret = `isolated-electron-replacement-${randomUUID()}`;
  credentialModel = await rpc('model.save', { model: credentialModel, secret: expectedSecret });
  credentialReferences.add(credentialModel.credentialRef);
  assert.equal((await rpc('model.test', { modelId: credentialModel.id })).connected, true);
  assert.equal(credentialRequests, 3);
  checks.nativeCredentialReplacement = true;
  await rpc('model.delete', { modelId: credentialModel.id }); credentialModel = undefined;
  await cleanupCredentialReferences();
  checks.nativeCredentialDeletion = true;
  checks.nativeCredentialRestart = true;
  await page.screenshot({ path: join(artifacts, 'desktop-restored-draft.png') });
  assert.deepEqual(errors, [], 'Native renderer must have no application errors');
  checks.consoleHealth = true;
  await close(1);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: 'passed', platform: process.platform, architecture: process.arch, packaged, distributionScope, relocatedExecutable: Boolean(process.env.VIDEO_QUICKLY_ELECTRON_EXECUTABLE), electron: actualElectronVersion, checks,
    nativeDialogs: 'file/directory/save selection, cancellation and close decisions substituted; OS dialog UI requires manual verification',
    nativeShell: 'reveal invocation substituted; Finder/Explorer UI requires manual verification',
    screenshots: ['desktop-editor.png', 'desktop-restored-draft.png'],
  }, null, 2));
  console.log('Electron 原生窗口、真实 IPC/Node、编辑历史、媒体 Range/导出、失联重连和重启草稿验收通过。');
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ status: 'failed', platform: process.platform, packaged, distributionScope, checks, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally {
  if (credentialModel && application) await rpc('model.delete', { modelId: credentialModel.id }).catch(() => {});
  if (application) await cleanupCredentialReferences().catch(() => {});
  credentialServer.closeAllConnections();
  await new Promise(resolveClose => credentialServer.close(resolveClose));
  if (application) await close().catch(() => { application?.process().kill('SIGKILL'); });
  if (runtimePid && processAlive(runtimePid)) process.kill(runtimePid, 'SIGKILL');
  await rm(fixture, { recursive: true, force: true });
}
