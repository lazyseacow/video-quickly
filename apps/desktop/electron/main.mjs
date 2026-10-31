import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { AsyncEntry } from '@napi-rs/keyring';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeController } from './runtime-controller.mjs';
import { createCredentialHost } from './credentials.mjs';
import { windowsJobContainer } from './windows-job.mjs';
import { applicationId, applicationOrigin, externalWebUrl, fileInside, pathDialogOptions, rendererIsTrusted, serveFile, validPath, validRuntimeRequest, workspaceDirectory } from './platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const dataDirectory = workspaceDirectory();
const developmentUrl = !app.isPackaged ? process.env.VIDEO_QUICKLY_DEV_URL : undefined;
if (developmentUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(developmentUrl)) throw new Error('桌面开发地址必须使用本机端口。');
app.setName('Video Quickly');
app.setAppUserModelId(applicationId);
// Keep Chromium state inside the new workspace, separate from former WebViews.
app.setPath('userData', process.env.VIDEO_QUICKLY_ELECTRON_USER_DATA ? resolve(process.env.VIDEO_QUICKLY_ELECTRON_USER_DATA) : join(dataDirectory, 'electron-session'));
protocol.registerSchemesAsPrivileged([{ scheme: 'video-quickly', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

let window;
let controller;
let exiting = false;
let shutdown;

function sendEvent(event) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('vq:runtime-event', event);
}

function trust(event) {
  if (!window || !rendererIsTrusted(event, window.webContents, developmentUrl)) throw new Error('不允许此页面调用桌面功能。');
}

function installIpc() {
  ipcMain.handle('vq:runtime', async (event, input) => {
    trust(event);
    const { method, params } = validRuntimeRequest(input);
    if (method === 'runtime.status') return controller.status();
    if (method === 'runtime.reconnect') return controller.reconnect();
    return controller.request(method, params);
  });
  ipcMain.handle('vq:asset-url', async (event, path) => {
    trust(event);
    await fileInside(dataDirectory, path);
    return `${applicationOrigin}/__asset?path=${encodeURIComponent(path)}`;
  });
  ipcMain.handle('vq:pick-path', async (event, input) => {
    trust(event);
    const { mode, options } = pathDialogOptions(input);
    if (mode === 'save') {
      const result = await dialog.showSaveDialog(window, options);
      return result.canceled ? null : result.filePath ?? null;
    }
    const result = await dialog.showOpenDialog(window, { ...options, properties: mode === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('vq:reveal-file', async (event, path) => {
    trust(event);
    validPath(path);
    await stat(path);
    shell.showItemInFolder(path);
  });
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Video Quickly', width: 1480, height: 960, minWidth: 1024, minHeight: 720, show: false,
    backgroundColor: '#141414', icon: join(here, '../build/icons/icon.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, navigateOnDragDrop: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url);
    if (external) void shell.openExternal(external).catch(() => dialog.showErrorBox('无法打开网页', '请在系统浏览器中打开该链接。'));
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = developmentUrl ? new URL(url).origin === new URL(developmentUrl).origin : url.startsWith(`${applicationOrigin}/`) && !url.startsWith(`${applicationOrigin}/__asset`);
    if (!allowed) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const owner = window;
  owner.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(owner, {
      type: 'question', title: '离开工作台？', message: '还有未保存的修改。',
      detail: '继续编辑以保存修改，或离开并在下次打开时检查本机草稿。',
      buttons: ['继续编辑', '离开'], defaultId: 0, cancelId: 0, noLink: true,
    });
    // Electron reverses the usual meaning here: preventDefault accepts unload.
    if (choice === 1) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = undefined; });
  void window.loadURL(developmentUrl ?? `${applicationOrigin}/`);
  return window;
}

async function launch() {
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(app.getPath('userData'), { recursive: true });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('video-quickly', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response(null, { status: 404 });
    if (url.pathname === '/__asset') {
      const path = url.searchParams.get('path');
      return path ? serveFile(dataDirectory, path, request) : new Response(null, { status: 404 });
    }
    let path;
    try { path = resolve(here, '../dist', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
    catch { return new Response(null, { status: 404 }); }
    return serveFile(resolve(here, '../dist'), path, request);
  });
  const sidecar = app.isPackaged ? join(process.resourcesPath, 'sidecar') : join(repository, '.generated', 'sidecar');
  const media = join(sidecar, 'media');
  const bundledFfmpeg = join(media, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const bundledFfprobe = join(media, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  controller = new RuntimeController({
    command: join(sidecar, process.platform === 'win32' ? 'node.exe' : 'node'),
    args: [join(sidecar, 'runtime.mjs'), '--data-dir', dataDirectory], cwd: sidecar,
    env: { ...process.env, VIDEO_QUICKLY_MODE: 'desktop', ...(existsSync(bundledFfmpeg) ? { VIDEO_QUICKLY_FFMPEG: bundledFfmpeg, VIDEO_QUICKLY_FFPROBE: bundledFfprobe } : {}) },
    hostRequest: createCredentialHost(AsyncEntry), onEvent: sendEvent, onSpawn: await windowsJobContainer(),
  });
  installIpc();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [{ role: 'close' }, { role: 'quit' }] },
    // Editor undo/redo and group selection belong to the React command history.
    // Registering native menu accelerators would intercept those key events.
    { label: '编辑', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    { label: '视图', submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }])] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ role: 'front' }] : [])] },
  ]));
  createWindow();
  // Show the window and recovery controls even when sidecar startup fails.
  try { await controller.start(); } catch { /* Connection state contains an actionable failure. */ }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('activate', () => { if (!shutdown && !window && controller) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // will-quit only runs after every window accepted beforeunload and closed.
  // A canceled quit must leave the runtime and all current work available.
  app.on('will-quit', event => {
    if (exiting) return;
    event.preventDefault();
    shutdown ??= Promise.resolve().then(() => controller?.close()).then(
      () => { exiting = true; app.quit(); },
      () => {
        exiting = true;
        dialog.showErrorBox('退出清理失败', '本地执行组件未能正常退出，请在重新打开后核对未完成任务。');
        app.exit(1);
      },
    );
  });
  void app.whenReady().then(launch).catch(error => {
    dialog.showErrorBox('Video Quickly 无法启动', error instanceof Error ? error.message : '桌面环境启动失败。');
    app.quit();
  });
}
