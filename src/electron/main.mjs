import { app, BrowserWindow, dialog, Menu, nativeImage, protocol, session, shell, Tray } from 'electron';
import { AsyncEntry } from '@napi-rs/keyring';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeController } from './runtime-controller.mjs';
import { createCredentialHost } from './credentials.mjs';
import { registerDesktopIpc, sendRuntimeEvent } from './desktop-ipc.mjs';
import { createLogger, logError } from './logging.mjs';
import { windowsJobContainer } from './windows-job.mjs';
import { applicationId, applicationOrigin, externalWebUrl, rendererPermissionAllowed, runtimeMediaEnvironment, serveFile, workspaceDirectory } from './platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const dataDirectory = workspaceDirectory();
const logger = createLogger({ dataDirectory, component: 'desktop' });
// Observe fatal errors without replacing Node/Electron's termination behavior.
process.on('uncaughtExceptionMonitor', (error, origin) => logger.error('desktop.uncaught_exception', { error: logError(error), reason: origin }));
const developmentUrl = !app.isPackaged ? process.env.VIDEO_QUICKLY_DEV_URL : undefined;
if (developmentUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(developmentUrl)) throw new Error('桌面开发地址必须使用本机端口。');
app.setName('Video Quickly');
app.setAppUserModelId(applicationId);
// Keep Chromium state alongside the workspace for isolated application profiles.
app.setPath('userData', process.env.VIDEO_QUICKLY_ELECTRON_USER_DATA ? resolve(process.env.VIDEO_QUICKLY_ELECTRON_USER_DATA) : join(dataDirectory, 'electron-session'));
protocol.registerSchemesAsPrivileged([{ scheme: 'video-quickly', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

let window;
let controller;
let exiting = false;
let shutdown;
const macFullscreenWindows = new WeakMap();
export let tray;
export let trayMenu;

async function waitForNativeFullscreenEntry(mainWindow) {
  const fullscreen = macFullscreenWindows.get(mainWindow);
  if (fullscreen.entered) return;
  const signal = AbortSignal.any([fullscreen.closed.signal, AbortSignal.timeout(5_000)]);
  await once(mainWindow, 'enter-full-screen', { signal });
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Video Quickly', width: 1480, height: 960, minWidth: 1024, minHeight: 720, show: false,
    backgroundColor: '#141414', icon: join(here, '../build/icons/icon.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, navigateOnDragDrop: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url);
    if (external) void shell.openExternal(external).catch(error => {
      logger.warn('desktop.external_open_failed', { error: logError(error) });
      dialog.showErrorBox('无法打开网页', '请在系统浏览器中打开该链接。');
    });
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = developmentUrl ? new URL(url).origin === new URL(developmentUrl).origin : url.startsWith(`${applicationOrigin}/`) && !url.startsWith(`${applicationOrigin}/__asset`);
    if (!allowed) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const owner = window;
  if (process.platform === 'darwin') {
    // Chromium enters HTML fullscreen before the native window finishes switching spaces.
    const fullscreen = { entered: false, closed: new AbortController() };
    macFullscreenWindows.set(owner, fullscreen);
    owner.on('enter-full-screen', () => { fullscreen.entered = true; });
    owner.on('leave-full-screen', () => { fullscreen.entered = false; });
    owner.once('closed', () => fullscreen.closed.abort());
  }
  owner.webContents.on('render-process-gone', (_event, details) => logger.error('desktop.renderer_gone', { reason: details.reason, exitCode: details.exitCode }));
  owner.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => logger.error('desktop.load_failed', { exitCode: code, status: mainFrame ? 'main_frame' : 'sub_frame' }));
  owner.webContents.on('preload-error', (_event, _path, error) => logger.error('desktop.preload_failed', { error: logError(error) }));
  owner.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(owner, {
      type: 'question', title: '离开工作台？', message: '还有未保存的修改。',
      detail: '继续编辑以保存修改，或离开并在下次打开时检查本机草稿。',
      buttons: ['继续编辑', '离开'], defaultId: 0, cancelId: 0, noLink: true,
    });
    // Electron reverses the usual meaning here: preventDefault accepts unload.
    if (choice === 1) event.preventDefault();
  });
  owner.once('ready-to-show', () => { logger.info('desktop.window_ready'); if (!owner.isDestroyed()) owner.show(); });
  owner.on('closed', () => { logger.info('desktop.window_closed'); if (window === owner) window = undefined; });
  void owner.loadURL(developmentUrl ?? `${applicationOrigin}/`).catch(error => logger.error('desktop.navigation_failed', { error: logError(error) }));
  return owner;
}

function activateWindow() {
  if (shutdown) return;
  if (!window && controller) createWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
}

async function launch() {
  logger.info('desktop.starting', { appVersion: app.getVersion(), platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, electronVersion: process.versions.electron, packaged: app.isPackaged });
  // The development Electron bundle has its own icon; packaged macOS uses its ICNS.
  if (!app.isPackaged) app.dock?.setIcon(join(here, '../build/icons/dock.png'));
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(app.getPath('userData'), { recursive: true });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(rendererPermissionAllowed(contents, permission, details, window?.webContents, developmentUrl)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => rendererPermissionAllowed(contents, permission, details, window?.webContents, developmentUrl));
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
  controller = new RuntimeController({
    command: join(sidecar, process.platform === 'win32' ? 'node.exe' : 'node'),
    args: [join(sidecar, 'runtime.mjs'), '--data-dir', dataDirectory], cwd: sidecar,
    env: runtimeMediaEnvironment(media, app.isPackaged),
    logger: logger.child({ component: 'runtime-controller' }),
    hostRequest: createCredentialHost(AsyncEntry), onEvent: event => sendRuntimeEvent(window, event), onSpawn: await windowsJobContainer(),
  });
  registerDesktopIpc({
    getMainWindow: () => window, runtimeController: controller, dataDirectory, developmentUrl, logger,
    waitForNativeFullscreenEntry: process.platform === 'darwin' ? waitForNativeFullscreenEntry : undefined,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [{ role: 'close' }, { role: 'quit' }] },
    // Editor undo/redo and group selection belong to the React command history.
    // Registering native menu accelerators would intercept those key events.
    { label: '编辑', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    { label: '视图', submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }])] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ role: 'front' }] : [])] },
  ]));
  const trayIcon = nativeImage.createFromPath(join(here, '../build/icons', process.platform === 'darwin' ? 'trayTemplate.png' : process.platform === 'win32' ? 'icon.ico' : '32x32.png'));
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  trayMenu = Menu.buildFromTemplate([
    { id: 'show-main', label: '显示主窗口', click: activateWindow },
    { id: 'quit', label: '退出 Video Quickly', click: () => app.quit() },
  ]);
  tray.setToolTip('Video Quickly');
  tray.setContextMenu(trayMenu);
  if (process.platform !== 'darwin') tray.on('click', activateWindow);
  createWindow();
  // Show the window and recovery controls even when sidecar startup fails.
  try { await controller.start(); logger.info('desktop.ready'); }
  catch (error) { logger.error('desktop.runtime_unavailable', { error: logError(error) }); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('child-process-gone', (_event, details) => logger.error('desktop.child_process_gone', { reason: details.reason, exitCode: details.exitCode }));
  app.on('second-instance', activateWindow);
  app.on('activate', activateWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // will-quit only runs after every window accepted beforeunload and closed.
  // A canceled quit must leave the runtime and all current work available.
  app.on('will-quit', event => {
    if (exiting) return;
    event.preventDefault();
    if (!shutdown) logger.info('desktop.stopping');
    shutdown ??= Promise.resolve().then(() => controller?.close()).then(
      () => { logger.info('desktop.stopped'); exiting = true; app.quit(); },
      error => {
        logger.error('desktop.shutdown_failed', { error: logError(error) });
        exiting = true;
        dialog.showErrorBox('退出清理失败', '本地执行组件未能正常退出，请在重新打开后核对未完成任务。');
        app.exit(1);
      },
    );
  });
  void app.whenReady().then(launch).catch(error => {
    logger.error('desktop.start_failed', { error: logError(error) });
    dialog.showErrorBox('Video Quickly 无法启动', error instanceof Error ? error.message : '桌面环境启动失败。');
    app.quit();
  });
}
