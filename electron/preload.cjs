const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanBridge', {
  startWatcher: (folderPath) => ipcRenderer.invoke('scan:startWatcher', folderPath),
  stopWatcher: () => ipcRenderer.invoke('scan:stopWatcher'),
  readFile: (filePath) => ipcRenderer.invoke('scan:readFile', filePath),
  deleteFile: (filePath) => ipcRenderer.invoke("scan:deleteFile", filePath),
  makeSearchablePdf: (filePath) => ipcRenderer.invoke("scan:makeSearchablePdf", filePath),
  getDefaultFolder: () => ipcRenderer.invoke('scan:getDefaultFolder'),
  onFileDetected: (cb) => {
    ipcRenderer.removeAllListeners('scan:fileDetected');
    ipcRenderer.on('scan:fileDetected', (_event, payload) => cb(payload));
  },
});
