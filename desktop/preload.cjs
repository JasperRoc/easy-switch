const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['state', 'client', 'switch', 'order', 'edit', 'remove', 'add-api', 'login', 'login-code', 'import-login', 'existing-login', 'models', 'reset-cards', 'consume-reset', 'network', 'save-network', 'start', 'stop', 'autostart', 'preferences', 'open-login', 'updates', 'update-download', 'update-install', 'star', 'quit']);
contextBridge.exposeInMainWorld('easySwitch', {
  call(action, payload) { if (!actions.has(action)) return Promise.reject(new Error('Unsupported action.')); return ipcRenderer.invoke('easy-switch:call', action, payload); },
  onChange(callback) { ipcRenderer.on('easy-switch:changed', (_event, state) => callback(state)); },
  onTab(callback) { ipcRenderer.on('easy-switch:tab', (_event, tab) => callback(tab)); },
});
