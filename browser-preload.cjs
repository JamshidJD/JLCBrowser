const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browser', {
  command: (action, value) => ipcRenderer.send('browser:command', action, value),
  onState: callback => ipcRenderer.on('browser:state', (_event, state) => callback(state)),
  onFocusAddress: callback => ipcRenderer.on('browser:focus-address', () => callback()),
});
