const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar', {
  send: (action) => ipcRenderer.send('bar', action),
  onState: (fn) => ipcRenderer.on('state', (_e, state) => fn(state)),
});
