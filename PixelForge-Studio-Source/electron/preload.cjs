const { contextBridge, ipcRenderer, webUtils } = require('electron');
function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).catch(error => {
    console.error(`[PixelForge IPC] ${channel} failed`, error);
    throw error;
  });
}
contextBridge.exposeInMainWorld('pixelForge', Object.freeze({
  openImage: () => invoke('pf:open'),
  openProject: () => invoke('pf:openProject'),
  readDroppedProject: file => {
    const filePath = webUtils.getPathForFile(file);
    return filePath ? invoke('pf:dropProject', filePath) : Promise.resolve(null);
  },
  saveProject: request => invoke('pf:saveProject', request),
  onCloseRequested: callback => {
    if (typeof callback !== 'function') throw new TypeError('Close callback must be a function');
    const handler = () => callback();
    ipcRenderer.on('pf:close-request', handler);
    return () => ipcRenderer.removeListener('pf:close-request', handler);
  },
  allowClose: () => invoke('pf:allowClose'),
  cancelClose: () => invoke('pf:cancelClose'),
  readDroppedImage: file => {
    const filePath = webUtils.getPathForFile(file);
    return filePath ? invoke('pf:dropImage', filePath) : Promise.resolve(null);
  },
  saveImage: options => invoke('pf:save', options),
  readPreferences: () => invoke('pf:readPrefs'),
  writePreferences: prefs => invoke('pf:writePrefs', prefs),
}));
