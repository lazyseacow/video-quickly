import { dialog, ipcMain, shell } from 'electron';
import { stat } from 'node:fs/promises';
import { applicationOrigin, fileInside, pathDialogOptions, rendererIsTrusted, validPath, validRuntimeRequest } from './platform.mjs';

export function sendRuntimeEvent(mainWindow, event) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('vq:runtime-event', event);
  }
}

export function registerDesktopIpc({ getMainWindow, runtimeController, dataDirectory, developmentUrl, logger, waitForNativeFullscreenEntry }) {
  function handleTrusted(channel, handle) {
    ipcMain.handle(channel, async (event, input) => {
      const mainWindow = getMainWindow();
      if (!mainWindow || !rendererIsTrusted(event, mainWindow.webContents, developmentUrl)) {
        logger.warn('ipc.rejected', { reason: 'untrusted_renderer' });
        throw new Error('不允许此页面调用桌面功能。');
      }
      return handle(mainWindow, input);
    });
  }

  handleTrusted('vq:runtime', (_mainWindow, input) => {
    let request;
    try { request = validRuntimeRequest(input); }
    catch (error) { logger.warn('ipc.rejected', { reason: 'invalid_request' }); throw error; }
    const { method, params } = request;
    if (method === 'runtime.status') return runtimeController.status();
    if (method === 'runtime.reconnect') return runtimeController.reconnect();
    return runtimeController.request(method, params);
  });
  handleTrusted('vq:asset-url', async (_mainWindow, path) => {
    await fileInside(dataDirectory, path);
    return `${applicationOrigin}/__asset?path=${encodeURIComponent(path)}`;
  });
  handleTrusted('vq:pick-path', async (mainWindow, input) => {
    const { mode, options } = pathDialogOptions(input);
    if (mode === 'save') {
      const result = await dialog.showSaveDialog(mainWindow, options);
      return result.canceled ? null : result.filePath ?? null;
    }
    const result = await dialog.showOpenDialog(mainWindow, { ...options, properties: mode === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handleTrusted('vq:reveal-file', async (_mainWindow, path) => {
    validPath(path);
    await stat(path);
    shell.showItemInFolder(path);
  });
  if (waitForNativeFullscreenEntry) handleTrusted('vq:wait-for-native-fullscreen-entry', waitForNativeFullscreenEntry);
}
