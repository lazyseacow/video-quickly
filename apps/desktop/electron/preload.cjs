const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoQuickly', Object.freeze({
  platform: process.platform,
  rpc: (method, params) => ipcRenderer.invoke('vq:runtime', { method, params }),
  assetUrl: path => ipcRenderer.invoke('vq:asset-url', path),
  pickPath: options => ipcRenderer.invoke('vq:pick-path', options),
  revealFile: path => ipcRenderer.invoke('vq:reveal-file', path),
  subscribe: listener => {
    if (typeof listener !== 'function') throw new TypeError('事件监听器无效。');
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('vq:runtime-event', receive);
    return () => ipcRenderer.removeListener('vq:runtime-event', receive);
  },
}));
