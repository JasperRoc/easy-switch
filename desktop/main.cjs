const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, Notification, powerMonitor, nativeTheme, screen, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { trayIdentity, trayImage, menuBarHidden, bindTrayActions } = require('./tray.cjs');

const root = path.resolve(process.env.SWITCH_HOME || path.join(os.homedir(), '.codex-switch'));
fs.mkdirSync(path.join(root, 'desktop-ui'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(root, 'desktop-ui'));
const ownsLock = app.requestSingleInstanceLock();
let window, tray, controller, updater, restoreSession, poll, updateTimer, quitting = false, quitReady = false, startupError = '', lastFailover;
let trayState = '', trayMenu, uiLanguage = 'en', translate;
const t = (key, values) => translate(uiLanguage, key, values);
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const repository = 'https://github.com/JasperRoc/easy-switch';

function showWindow(tab) {
  if (!window || window.isDestroyed()) return;
  if (process.platform === 'darwin') { app.setActivationPolicy('regular'); app.dock.show(); }
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
  if (tab) window.webContents.send('easy-switch:tab', tab);
}
function report(error) {
  startupError = error.message || String(error);
  window?.webContents.send('easy-switch:changed');
  dialog.showErrorBox('easy-switch', startupError);
}
function snapshot() { return { ...controller.snapshot(), error: startupError, version: app.getVersion(), update: updater.snapshot(), menuBarHidden: process.platform === 'darwin' && tray && menuBarHidden(tray.getBounds(), screen.getAllDisplays()), language: uiLanguage, theme: controller.preferences().theme || 'system', dark: nativeTheme.shouldUseDarkColors, platform: process.platform, loginItem: app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}).openAtLogin }; }
function updateTray() {
  if (!controller || !tray) return;
  const state = snapshot();
  const signature = JSON.stringify([state.running, state.active, state.providers, state.model, state.loginItem, state.lastFailover, uiLanguage, state.update.phase, state.update.version]);
  if (signature === trayState) return;
  trayState = signature;
  const model = state.model ? `${state.model.model} · ${state.model.effort || t('providerDefault')}` : t('followCodex');
  tray.setToolTip(`easy-switch · ${state.active || t('addProvider')} · ${model}`);
  trayMenu = Menu.buildFromTemplate([
    { label: state.running ? t('trayActive', { alias: state.active || t('noProvider') }) : t('trayStopped'), enabled: false },
    { label: model, enabled: false }, { type: 'separator' },
    ...state.providers.map(provider => ({ label: `${provider.alias} · ${t(provider.type === 'account' ? 'account' : 'api')}${provider.needsLogin ? ' · ' + t('loginNeeded') : ''}`, type: 'radio', checked: provider.active,
      click: () => { try { controller.switchProvider(provider.alias); updateTray(); window?.webContents.send('easy-switch:changed'); } catch (error) { report(error); } } })),
    { type: 'separator' },
    { label: t('trayModel'), click: () => showWindow('model') },
    { label: t('traySettings'), click: () => showWindow('providers') },
    { label: t('autoStart'), type: 'checkbox', checked: state.loginItem, click: item => { try { setAutoStart(item.checked); } catch (error) { report(error); } } },
    { label: t('updates'), click: () => showWindow('updates') },
    { type: 'separator' }, { label: t('quit'), click: () => app.quit() },
  ]);
  if (lastFailover !== undefined && state.lastFailover?.at !== lastFailover && state.lastFailover && Notification.isSupported()) {
    const event = state.lastFailover;
    new Notification({ title: t('notifyTitle'), body: `${event.from} → ${event.to} (HTTP ${event.status})` }).show();
  }
  lastFailover = state.lastFailover?.at || null;
}
function setAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled, ...(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}) });
  const applied = app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}).openAtLogin;
  controller.setPreferences({ startAtLogin: applied }); updateTray();
  if (applied !== !!enabled) throw new Error(t('loginPermission'));
}

async function boot() {
  const { DesktopController } = await import('./controller.js');
  const { DesktopUpdater } = await import('./updater.js');
  const i18n = await import('./i18n.js'); translate = i18n.translate;
  ({ restoreSession } = await import('./config.js'));
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'codex', exe) : path.join(__dirname, '..', '.desktop-cache', `codex-${process.platform}-${process.arch}`, exe);
  const binary = process.env.SWITCH_CODEX_BIN || bundled;
  controller = new DesktopController({ root, codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), binary, port: Number(process.env.SWITCH_PORT ?? 18345), guardExec: process.execPath });
  const updateSession = session.fromPartition('easy-switch-updates', { cache: false });
  updater = new DesktopUpdater({ root, current: app.getVersion(),
    systemFetch: (url, options) => updateSession.fetch(url, { ...options, credentials: 'omit' }),
    useSystemNetwork: () => !['saved', 'environment'].includes(controller.network().source),
    changed: () => { window?.webContents.send('easy-switch:changed'); updateTray(); } });
  uiLanguage = i18n.normalizeLanguage(controller.preferences().language || app.getLocale());
  nativeTheme.themeSource = controller.preferences().theme || 'system';
  window = new BrowserWindow({ width: 960, height: 780, minWidth: 780, minHeight: 680, show: false, backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f2f2f6', title: 'easy-switch',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 18 }, vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('hide', () => { if (process.platform === 'darwin') { app.dock.hide(); app.setActivationPolicy('accessory'); } });
  window.on('session-end', () => { try { restoreSession(controller.runtime.recordFile); } catch {} });
  powerMonitor.on('shutdown', () => { try { restoreSession(controller.runtime.recordFile); } catch {} });
  ipcMain.handle('easy-switch:call', async (event, action, payload) => {
    if (event.senderFrame?.url !== page) throw new Error('Untrusted application frame.');
    try {
      let result;
      switch (action) {
        case 'state': return snapshot();
        case 'switch': result = controller.switchProvider(payload); break;
        case 'remove': result = controller.remove(payload); break;
        case 'order': result = controller.order(payload); break;
        case 'add-api': result = controller.addAPI(payload); break;
        case 'login': result = await controller.startLogin(payload); break;
        case 'existing-login': return controller.existingLogin();
        case 'import-login': result = controller.importLogin(payload); break;
        case 'models': return await controller.models();
        case 'usage': return controller.refreshUsage(payload);
        case 'model': result = controller.model(payload); break;
        case 'session-model': {
          if (typeof payload?.sessionId !== 'string') throw new Error('Choose a session observed by this app first.');
          result = controller.model(payload.selection, payload.sessionId); break;
        }
        case 'network': return controller.network();
        case 'save-network': result = await controller.saveNetwork(payload); break;
        case 'start': await controller.start(); startupError = ''; result = snapshot(); break;
        case 'stop': await controller.stop(); result = snapshot(); break;
        case 'preferences':
          controller.setPreferences(payload); uiLanguage = i18n.normalizeLanguage(controller.preferences().language || app.getLocale());
          nativeTheme.themeSource = controller.preferences().theme || 'system';
          window.webContents.send('easy-switch:changed'); nativeMenu(); result = snapshot(); break;
        case 'autostart': setAutoStart(payload); result = snapshot(); break;
        case 'open-login': {
          const url = controller.login?.url;
          if (url === 'https://auth.openai.com/codex/device') await shell.openExternal(url);
          return null;
        }
        case 'updates': return await updater.check();
        case 'update-download': if (!app.isPackaged) throw new Error(t('updateDevelopment')); await updater.download(); return updater.snapshot();
        case 'update-install': {
          if (!app.isPackaged) throw new Error(t('updateDevelopment'));
          if (controller.runtime.activeRequests) {
            const choice = await dialog.showMessageBox(window, { type: 'warning', buttons: [t('keepRunning'), t('installUpdate')], defaultId: 0, cancelId: 0, message: t('requestsRunning'), detail: t('updateRestartWarning') });
            if (choice.response !== 1) return updater.snapshot();
          }
          await controller.stop();
          try { await updater.install({ codexHome: controller.codexHome }); }
          catch (error) { updater.emit({ phase: 'ready', error: error.message }); await controller.start(); throw error; }
          quitting = true; quitReady = true; clearInterval(poll); clearInterval(updateTimer); app.quit(); return null;
        }
        case 'star': await shell.openExternal(repository); return null;
        case 'quit': app.quit(); return null;
        default: throw new Error('Unsupported application action.');
      }
      updateTray(); return { ...result, error: startupError, version: app.getVersion() };
    } catch (error) { throw new Error(error.message || 'Operation failed.'); }
  });
  tray = new Tray(trayImage(nativeImage, path.join(__dirname, 'assets'), process.platform), trayIdentity(root));
  bindTrayActions(tray, showWindow, () => trayMenu);
  app.dock?.hide();
  try { await controller.start(); } catch (error) { startupError = error.message; }
  await window.loadFile(path.join(__dirname, 'index.html'));
  updateTray(); updater.confirmLaunch();
  nativeTheme.on('updated', () => window?.webContents.send('easy-switch:changed'));
  poll = setInterval(() => { try { updateTray(); window?.webContents.send('easy-switch:changed'); } catch {} }, 1500);
  if (app.isPackaged && !process.env.SWITCH_TEST_DESKTOP) {
    const check = () => updater.check().catch(() => {});
    setTimeout(check, 3000).unref(); updateTimer = setInterval(check, 6 * 60 * 60 * 1000); updateTimer.unref();
  }
  const nativeMenu = () => { if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'easy-switch', submenu: [{ role: 'about' }, { label: t('updates'), click: () => showWindow('updates') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { label: t('quit'), accelerator: 'Command+Q', click: () => app.quit() }] }, { role: 'editMenu' }, { role: 'windowMenu' }])); };
  nativeMenu();
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
        const choice = await dialog.showMessageBox(window, { type: 'warning', buttons: [t('keepRunning'), t('quitShort')], defaultId: 0, cancelId: 0,
          message: t('requestsRunning'), detail: t('quitDetail') });
        if (choice.response !== 1) return;
      }
      quitting = true;
      try { await controller?.stop(); clearInterval(poll); clearInterval(updateTimer); quitReady = true; app.quit(); }
      catch (error) { quitting = false; report(error); }
    })().catch(report);
  });
  app.whenReady().then(boot).catch(error => { report(error); quitReady = true; app.quit(); });
}
