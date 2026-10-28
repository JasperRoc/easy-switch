const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['state', 'switch', 'order', 'add-api', 'login', 'import-login', 'models', 'model', 'network', 'save-network', 'start', 'stop', 'autostart', 'open-login', 'updates', 'quit']);
contextBridge.exposeInMainWorld('easySwitch', {
  call(action, payload) { if (!actions.has(action)) return Promise.reject(new Error('Unsupported action.')); return ipcRenderer.invoke('easy-switch:call', action, payload); },
  onChange(callback) { ipcRenderer.on('easy-switch:changed', () => callback()); },
  onTab(callback) { ipcRenderer.on('easy-switch:tab', (_event, tab) => callback(tab)); },
});
