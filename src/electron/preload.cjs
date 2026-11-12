// @ts-check
const { contextBridge, ipcRenderer } = require('electron');

/** @type {import('@video-quickly/contracts').DesktopBridge} */
const desktopBridge = {
  platform: process.platform,
  rpc: (method, params) => ipcRenderer.invoke('vq:runtime', { method, params }),
  assetUrl: path => ipcRenderer.invoke('vq:asset-url', path),
  pickPath: options => ipcRenderer.invoke('vq:pick-path', options),
  revealFile: path => ipcRenderer.invoke('vq:reveal-file', path),
  ...(process.platform === 'darwin' ? { waitForNativeFullscreenEntry: () => ipcRenderer.invoke('vq:wait-for-native-fullscreen-entry') } : {}),
  subscribe: listener => {
    if (typeof listener !== 'function') throw new TypeError('事件监听器无效。');
    /**
     * @param {import('electron').IpcRendererEvent} _event
     * @param {unknown} value
     */
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('vq:runtime-event', receive);
    return () => ipcRenderer.removeListener('vq:runtime-event', receive);
  },
};

contextBridge.exposeInMainWorld('videoQuickly', Object.freeze(desktopBridge));
