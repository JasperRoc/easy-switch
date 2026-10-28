const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, Notification, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(process.env.SWITCH_HOME || path.join(os.homedir(), '.codex-switch'));
fs.mkdirSync(path.join(root, 'desktop-ui'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(root, 'desktop-ui'));
const ownsLock = app.requestSingleInstanceLock();
let window, tray, controller, restoreSession, poll, quitting = false, quitReady = false, startupError = '', lastFailover;
let trayState = '';
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const downloads = 'https://github.com/JasperRoc/easy-switch/releases';

function showWindow(tab) {
  if (!window || window.isDestroyed()) return;
  window.show(); window.focus();
  if (tab) window.webContents.send('easy-switch:tab', tab);
}
function report(error) {
  startupError = error.message || String(error);
  window?.webContents.send('easy-switch:changed');
  dialog.showErrorBox('easy-switch', startupError);
}
function snapshot() { return { ...controller.snapshot(), error: startupError, version: app.getVersion(), loginItem: app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}).openAtLogin }; }
function updateTray() {
  if (!controller || !tray) return;
  const state = snapshot();
  const signature = JSON.stringify([state.running, state.active, state.providers, state.model, state.loginItem, state.lastFailover]);
  if (signature === trayState) return;
  trayState = signature;
  const model = state.model ? `${state.model.model} · ${state.model.effort || 'default'}` : 'Follow Codex';
  tray.setToolTip(`easy-switch · ${state.active || 'Add a provider'} · ${model}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.running ? `Active · ${state.active || 'No provider'}` : 'Routing is stopped', enabled: false },
    { label: model, enabled: false }, { type: 'separator' },
    ...state.providers.map(provider => ({ label: `${provider.alias} · ${provider.type}${provider.needsLogin ? ' · Sign-in needed' : ''}`, type: 'radio', checked: provider.active,
      click: () => { try { controller.switchProvider(provider.alias); updateTray(); window?.webContents.send('easy-switch:changed'); } catch (error) { report(error); } } })),
    { type: 'separator' },
    { label: 'Model & effort…', click: () => showWindow('model') },
    { label: 'Providers & settings…', click: () => showWindow('providers') },
    { label: 'Start at login', type: 'checkbox', checked: state.loginItem, click: item => { try { setAutoStart(item.checked); } catch (error) { report(error); } } },
    { label: 'Downloads & updates', click: () => shell.openExternal(downloads) },
    { type: 'separator' }, { label: 'Quit easy-switch', click: () => app.quit() },
  ]));
  if (lastFailover !== undefined && state.lastFailover?.at !== lastFailover && state.lastFailover && Notification.isSupported()) {
    const event = state.lastFailover;
    new Notification({ title: 'Provider switched automatically', body: `${event.from} → ${event.to} (HTTP ${event.status})` }).show();
  }
  lastFailover = state.lastFailover?.at || null;
}
function setAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled, ...(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}) });
  const applied = app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}).openAtLogin;
  controller.setPreferences({ startAtLogin: applied }); updateTray();
  if (applied !== !!enabled) throw new Error('The operating system did not apply the login startup setting. Check login-item permissions in system settings.');
}

async function boot() {
  const { DesktopController } = await import('./controller.js');
  ({ restoreSession } = await import('./config.js'));
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'codex', exe) : path.join(__dirname, '..', '.desktop-cache', `codex-${process.platform}-${process.arch}`, exe);
  const binary = process.env.SWITCH_CODEX_BIN || bundled;
  controller = new DesktopController({ root, codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), binary, guardExec: process.execPath });
  window = new BrowserWindow({ width: 940, height: 730, minWidth: 760, minHeight: 620, show: false, backgroundColor: '#f4f7fb', title: 'easy-switch',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('session-end', () => { try { restoreSession(controller.runtime.recordFile); } catch {} });
  powerMonitor.on('shutdown', () => { try { restoreSession(controller.runtime.recordFile); } catch {} });
  ipcMain.handle('easy-switch:call', async (event, action, payload) => {
    if (event.senderFrame?.url !== page) throw new Error('Untrusted application frame.');
    try {
      let result;
      switch (action) {
        case 'state': return snapshot();
        case 'switch': result = controller.switchProvider(payload); break;
        case 'order': result = controller.order(payload); break;
        case 'add-api': result = controller.addAPI(payload); break;
        case 'login': result = await controller.startLogin(payload); break;
        case 'import-login': result = controller.importLogin(payload); break;
        case 'models': return await controller.models();
        case 'model': result = controller.model(payload); break;
        case 'network': return controller.network();
        case 'save-network': result = await controller.saveNetwork(payload); break;
        case 'start': await controller.start(); startupError = ''; result = snapshot(); break;
        case 'stop': await controller.stop(); result = snapshot(); break;
        case 'autostart': setAutoStart(payload); result = snapshot(); break;
        case 'open-login': {
          const url = controller.login?.url;
          if (url === 'https://auth.openai.com/codex/device') await shell.openExternal(url);
          return null;
        }
        case 'updates': await shell.openExternal(downloads); return null;
        case 'quit': app.quit(); return null;
        default: throw new Error('Unsupported application action.');
      }
      updateTray(); return { ...result, error: startupError, version: app.getVersion() };
    } catch (error) { throw new Error(error.message || 'Operation failed.'); }
  });
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  image.setTemplateImage(process.platform === 'darwin'); tray = new Tray(image);
  if (process.platform === 'win32') tray.on('double-click', () => showWindow());
  app.dock?.hide();
  try { await controller.start(); } catch (error) { startupError = error.message; }
  await window.loadFile(path.join(__dirname, 'index.html'));
  updateTray();
  poll = setInterval(() => { try { updateTray(); window?.webContents.send('easy-switch:changed'); } catch {} }, 1500);
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!hidden || !controller.snapshot().providers.length || startupError) showWindow();
}

if (!ownsLock) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    (async () => {
      if (controller?.runtime.activeRequests) {
        const choice = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Keep running', 'Quit'], defaultId: 0, cancelId: 0,
          message: 'Codex requests are still running.', detail: 'Quitting interrupts them and restores the original Codex configuration. Open clients may need a restart or reload.' });
        if (choice.response !== 1) return;
      }
      quitting = true;
      try { await controller?.stop(); clearInterval(poll); quitReady = true; app.quit(); }
      catch (error) { quitting = false; report(error); }
    })().catch(report);
  });
  app.whenReady().then(boot).catch(error => { report(error); quitReady = true; app.quit(); });
}
