import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { chromium } from 'playwright-core';

const worker = fileURLToPath(new URL('../../desktop/worker.js', import.meta.url));
const networkFixture = fileURLToPath(new URL('./worker-network.js', import.meta.url));
const desktop = process.env.SWITCH_TEST_DESKTOP_EXE;
const executable = process.env.SWITCH_TEST_CHROMIUM || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32' ? undefined : '/usr/bin/google-chrome');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function rpc(env, changed) {
  const process = spawn(globalThis.process.execPath, ['--import', networkFixture, worker], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(process, 'exit').catch(() => {});
  const pending = new Map();
  let id = 0;
  const replies = readline.createInterface({ input: process.stdout });
  replies.on('line', line => {
    const response = JSON.parse(line);
    if (response.changed) { changed(); return; }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(new Error(response.error));
    else waiter.resolve(response.value);
  });
  process.once('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('The feature worker exited.')); });
  return {
    call(action, payload, context) {
      return new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        process.stdin.write(JSON.stringify({ id, action, payload, context }) + '\n', error => {
          if (error && pending.delete(id)) reject(error);
        });
      });
    },
    async close() { process.stdin.end(); await closed; },
  };
}

async function readRoute(file) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const provider = parse(fs.readFileSync(file, 'utf8')).model_providers?.fluid;
      if (provider) {
        const response = await fetch(new URL('/health', provider.base_url), { headers: provider.http_headers, signal: AbortSignal.timeout(250) });
        if (response.ok) return provider;
      }
    } catch {}
    await delay(50);
  }
  throw new Error('The native gateway did not start.');
}

// Run the real renderer and TypeScript commands. Native tray, WebView and installer
// lifecycle have a separate packaged smoke test.
export async function launchRenderer(t, project, extraEnv = {}, initialConfig, prepare) {
  assert.ok(desktop, 'Set SWITCH_TEST_DESKTOP_EXE to the headless Rust gateway for the renderer tests.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-renderer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, '.desktop-test'), { recursive: true });
  const root = path.join(directory, 'data'), home = path.join(directory, 'codex'), desktopHome = path.join(directory, 'desktop-clients');
  fs.mkdirSync(root); fs.mkdirSync(home); fs.mkdirSync(path.join(desktopHome, 'Claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desktop.json'), JSON.stringify({ language: 'en', theme: 'light' }));
  const file = path.join(home, 'config.toml'), original = initialConfig ?? '# Original user config\nmodel="gpt-6.1-sol"\n';
  fs.writeFileSync(file, original);
  prepare?.(root);
  const env = { ...process.env, SWITCH_HOME: root, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    SWITCH_CLAUDE_DESKTOP_HOME: desktopHome, SWITCH_PORT: '0', SWITCH_CODEX_BIN: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*', ...extraEnv };
  const apiFixtureFile = path.join(directory, 'mock-http.json'), apiFixtures = new Map();
  const set = apiFixtures.set.bind(apiFixtures);
  apiFixtures.set = (url, value) => {
    set(url, value);
    fs.writeFileSync(apiFixtureFile, JSON.stringify(Object.fromEntries(apiFixtures)));
    return apiFixtures;
  };
  env.SWITCH_TEST_NETWORK_FIXTURE = apiFixtureFile;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const assets = path.join(project, 'webview');
    const name = path.resolve(assets, '.' + url.pathname);
    if (!name.startsWith(assets + path.sep)) {
      res.writeHead(404).end(); return;
    }
    fs.readFile(name, (error, bytes) => {
      if (error) res.writeHead(404).end();
      else res.writeHead(200, { 'content-type': mime[path.extname(name)] || 'application/octet-stream' }).end(bytes);
    });
  }).listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: executable });
  t.after(async () => { await browser.close(); });
  const options = { env, restart: start };
  async function start() {
    const context = await browser.newContext({ viewport: { width: 960, height: 780 } });
    let page, uiActive = true, minimized = false, sleeping = false, locked = false;
    let codexVersion, nativeLogin = false;
    let folder, external;
    const listeners = new Map();
    const notify = (event, value) => page?.evaluate(([event, value]) => window.fluidEvent?.(event, value), [event, value]).catch(() => {});
    const local = await new Promise(resolve => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
    });
    const config = { ...env, SWITCH_PORT: String(local) };
    const feature = rpc(config, () => { if (uiActive && !locked && !sleeping) void notify('change'); });
    const gateway = spawn(desktop, ['--renderer-test'], { env: { ...config, FLUID_NODE: process.execPath, FLUID_WORKER:
      fileURLToPath(new URL('../../src/service-worker.js', import.meta.url)) }, stdio: ['ignore', 'ignore', 'inherit'] });
    const exited = once(gateway, 'exit').catch(() => {});
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      await feature.call('stop').catch(() => {});
      if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill();
      await exited;
      await feature.close();
      await context.close();
    };
    t.after(close);
    await feature.call('activate');
    await readRoute(file);
    const initial = async (_event, action, payload) => {
      if (action === 'autostart') return;
      if (action === 'sync-guide') return external?.('https://github.com/JasperRoc/fluid/blob/main/docs/task-sync' + (payload === 'zh-CN' ? '.zh-CN' : '') + '.md');
      if (action === 'open-login' || action === 'star') return;
      if (action === 'update-install') return null;
      if (action === 'skill-discover' && payload.kind === 'folder' && folder) {
        const selected = await folder();
        if (selected.canceled) return null;
        payload = { ...payload, source: selected.filePaths[0] };
      }
      return feature.call(action, payload, { version: codexVersion, activeRequests: 0 });
    };
    const handlers = new Map([['fluid:call', initial]]);
    await context.exposeFunction('testDesktopCall', (action, payload) => {
      if (action === 'retain-window') return null;
      return handlers.get('fluid:call')(null, action, payload);
    });
    await context.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: (_command, { action, payload }) => window.testDesktopCall(action, payload) }; });
    page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto('http://127.0.0.1:' + server.address().port + '/desktop/index.html');
    await page.locator('#routing-toggle[aria-checked="true"]').waitFor();
    assert.equal(parse(fs.readFileSync(file, 'utf8')).features.api_key_model_discovery, true);
    await feature.call('foreground', true);
    const view = {
      webContents: { send(_channel, state) { if (uiActive) return notify('change', state); } },
      isVisible: () => uiActive,
      isMinimized: () => minimized,
      hide() { uiActive = false; void feature.call('foreground', false); },
      close() { this.hide(); },
      show() {
        if (locked || sleeping) return;
        const wasMinimized = minimized; uiActive = true; minimized = false;
        void notify('show');
        if (wasMinimized) { listeners.get('restore')?.(); listeners.delete('restore'); }
        return feature.call('foreground', true).then(() => this.webContents.send('fluid:changed'));
      },
      once(event, callback) { listeners.set(event, callback); },
      minimize() { this.hide(); minimized = true; listeners.get('minimize')?.(); listeners.delete('minimize'); },
      setSize(width, height) { return page.setViewportSize({ width, height }); },
    };
    const api = {
      BrowserWindow: { getAllWindows: () => [view] },
      app: { emit(event) { if (event === 'activate') view.show(); }, getLoginItemSettings: () => ({ openAtLogin: nativeLogin }) },
      ipcMain: { _invokeHandlers: handlers, removeHandler: key => handlers.delete(key), handle: (key, handler) => handlers.set(key, handler) },
      powerMonitor: { emit(event) {
        if (event === 'lock-screen') locked = true;
        if (event === 'unlock-screen') locked = false;
        if (event === 'suspend') sleeping = true;
        if (event === 'resume') sleeping = false;
        if (!sleeping && !locked && event === 'unlock-screen') return view.show();
      } },
      dialog: { set showOpenDialog(value) { folder = value; } },
      shell: { set openExternal(value) { external = value; } },
      apiFixtures,
      activeVersion(version) { codexVersion = version; },
    };
    return { page, firstWindow: () => page, close, evaluate: (fn, value) => fn(api, value) };
  }
  const app = await start();
  return { app, page: app.page, root, home, options, file, original };
}
