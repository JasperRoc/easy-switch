import fs from 'node:fs';
import path from 'node:path';
import { init, aliasName, addProvider, removeProvider, activate, readState, providerOrder, setOrder, setModel, baseURL, accountAuth, atomic } from '../src/store.js';
import { createReauth, expired } from '../src/auth.js';
import { codexModels, discoverModels } from '../src/catalog.js';
import { saveNetwork, networkEnvironment } from '../src/network.js';
import { detectSystemProxy, desktopNetworkSettings, proxyEnvironment, publicProxyURL } from './network.js';
import { DesktopRuntime, protectDirectory } from './runtime.js';
import { existingProvider } from './import.js';

export class DesktopController {
  constructor({ root, codexHome, binary, port = 18345, guardExec, env = process.env, detectProxy = detectSystemProxy }) {
    Object.assign(this, { root, codexHome, binary });
    this.originalEnv = { ...env }; this.detectProxy = detectProxy; this.detectedProxy = {};
    protectDirectory(root);
    this.login = null; this.catalog = null;
    this.reauth = createReauth();
    const prompt = this.reauth.prompt;
    this.reauth.prompt = provider => Object.values(readState(root).providers).some(item => item.accountHome === provider.accountHome)
      ? prompt(provider) : Promise.resolve('The provider was removed. Retry with the selected provider.');
    this.runtime = new DesktopRuntime({ root, codexHome, port, reauth: this.reauth, guardExec });
    this.preferencesFile = path.join(root, 'desktop.json');
  }
  preferences() {
    try { return JSON.parse(fs.readFileSync(this.preferencesFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  setPreferences(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const valid = key === 'language' ? ['en', 'zh-CN'].includes(value) : key === 'theme' ? ['system', 'light', 'dark'].includes(value) : key === 'startAtLogin' && typeof value === 'boolean';
      if (!valid) throw new Error('Invalid desktop preference.');
    }
    atomic(this.preferencesFile, { ...this.preferences(), ...patch });
  }
  async start() {
    process.env.SWITCH_CODEX_BIN = this.binary;
    await this.configureNetwork();
    await this.runtime.start();
  }
  async stop() { await this.runtime.stop(); this.reauth.close(); }
  snapshot() {
    const state = init(this.root);
    const providers = providerOrder(state).map(alias => {
      const provider = state.providers[alias];
      let needsLogin = false;
      if (provider.type === 'account') { try { needsLogin = expired(accountAuth(provider)); } catch { needsLogin = true; } }
      return { alias, type: provider.type, baseUrl: provider.baseUrl || '', active: alias === state.active, needsLogin };
    });
    return { running: !!this.runtime.server && this.runtime.active, providers, active: state.active, model: state.modelSelection || null,
      lastFailover: state.lastFailover || null, login: this.login && { alias: this.login.alias, phase: this.login.phase, message: this.login.message, url: this.login.url, code: this.login.code },
      activeRequests: this.runtime.activeRequests, preferences: this.preferences() };
  }
  switchProvider(alias) { activate(aliasName(alias), this.root); this.catalog = null; return this.snapshot(); }
  order(aliases) { setOrder(aliases, this.root); return this.snapshot(); }
  remove(alias) {
    const provider = readState(this.root).providers[alias];
    if (!provider) throw new Error('Unknown provider.');
    removeProvider(alias, this.root); this.catalog = null;
    if (provider.type === 'account') {
      this.reauth.cancel(provider);
      if (this.login?.alias === alias) this.login = null;
      const owned = path.join(this.root, 'accounts', alias);
      if (path.resolve(provider.accountHome) === owned && fs.existsSync(owned) && !fs.lstatSync(owned).isSymbolicLink() &&
          fs.realpathSync(path.dirname(owned)) === path.join(fs.realpathSync(this.root), 'accounts') &&
          !Object.values(readState(this.root).providers).some(item => item.accountHome === provider.accountHome)) fs.rmSync(owned, { recursive: true, force: true });
    }
    return this.snapshot();
  }
  addAPI({ alias, url = '', key }) {
    aliasName(alias);
    if (typeof key !== 'string' || !key.trim() || key.length > 8192) throw new Error('Enter a valid API key.');
    addProvider(alias, { type: 'api', baseUrl: baseURL(url.trim()), apiKey: key.trim() }, this.root);
    return this.snapshot();
  }
  async startLogin(alias) {
    aliasName(alias);
    if (this.login && ['starting', 'pending'].includes(this.login.phase)) throw new Error('Finish the current sign-in first.');
    const state = init(this.root), existing = state.providers[alias];
    if (existing && existing.type !== 'account') throw new Error('That alias belongs to an API provider.');
    const accountHome = existing?.accountHome || path.join(this.root, 'accounts', alias);
    fs.mkdirSync(accountHome, { recursive: true, mode: 0o700 });
    const task = this.reauth.start({ type: 'account', accountHome });
    const login = { alias, phase: 'starting', message: 'Preparing official device sign-in…' };
    this.login = login;
    task.completed.then(result => {
      delete login.url; delete login.code;
      login.message = result.message;
      if (!result.success) { login.phase = 'failed'; return; }
      try {
        if (!existing) addProvider(alias, { type: 'account', accountHome }, this.root);
        login.phase = 'complete';
        login.message = 'Signed in successfully.';
        this.catalog = null;
      } catch { login.phase = 'failed'; login.message = 'Sign-in completed, but that alias was added elsewhere. Use a different alias.'; }
    });
    const message = await task.ready;
    if (login.phase === 'starting') {
      login.message = message; login.phase = 'pending';
      login.url = message.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0];
      login.code = message.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0];
    }
    return this.snapshot();
  }
  existingLogin() {
    const provider = existingProvider({ codexHome: this.codexHome, root: this.root, env: this.originalEnv });
    let alias = String(provider.name).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 48) || 'codex-import';
    try { aliasName(alias); } catch { alias = 'codex-import'; }
    const state = init(this.root), suggested = alias; let suffix = 2;
    while (state.providers[alias]) alias = `${suggested}-${suffix++}`;
    return { type: provider.type, baseUrl: provider.baseUrl || '', alias };
  }
  importLogin(alias) {
    aliasName(alias);
    const provider = existingProvider({ codexHome: this.codexHome, root: this.root, env: this.originalEnv });
    const state = init(this.root);
    if (state.providers[alias]) throw new Error('That alias already exists.');
    if (provider.type === 'api') return this.addAPI({ alias, url: provider.baseUrl, key: provider.apiKey });
    const accountHome = path.join(this.root, 'accounts', alias);
    atomic(path.join(accountHome, 'auth.json'), provider.auth);
    addProvider(alias, { type: 'account', accountHome }, this.root);
    return this.snapshot();
  }
  async models() {
    const state = readState(this.root), provider = state.providers[state.active];
    if (!provider) throw new Error('Add a provider first.');
    const result = await discoverModels(provider, this.root, { catalogImpl: account => codexModels({ binary: this.binary, provider: account }) });
    if (readState(this.root).active !== state.active) throw new Error('The provider changed while loading models. Refresh the catalog again.');
    this.catalog = { alias: state.active, ...result };
    return result;
  }
  model(selection) {
    if (!selection) { setModel(null, this.root); return this.snapshot(); }
    const entry = this.catalog?.models.find(model => model.id === selection.model);
    if (!entry || (selection.effort !== null && !entry.efforts.includes(selection.effort))) throw new Error('Reload the model catalog and choose a supported effort.');
    setModel(selection, this.root, this.catalog.alias);
    return this.snapshot();
  }
  async configureNetwork() {
    this.detectedProxy = await this.detectProxy();
    this.networkInfo = desktopNetworkSettings(this.root, this.originalEnv, this.detectedProxy);
    Object.assign(process.env, networkEnvironment(this.root, { ...this.originalEnv, ...proxyEnvironment(this.networkInfo) }));
  }
  network() {
    const settings = this.networkInfo || desktopNetworkSettings(this.root, this.originalEnv, this.detectedProxy);
    return { ...settings, detected: { url: publicProxyURL(settings.detected.httpsProxy || settings.detected.httpProxy), source: settings.detected.source },
      localProxy: { url: `http://127.0.0.1:${this.runtime.port}/v1`, running: !!this.runtime.server && this.runtime.active } };
  }
  async saveNetwork({ proxy = '', noProxy = '' }) {
    if (typeof proxy !== 'string' || typeof noProxy !== 'string') throw new Error('Invalid network settings.');
    const env = { HTTP_PROXY: proxy.trim(), HTTPS_PROXY: proxy.trim(), ALL_PROXY: '', NO_PROXY: noProxy,
      http_proxy: proxy.trim(), https_proxy: proxy.trim(), all_proxy: '', no_proxy: noProxy };
    saveNetwork(this.root, env);
    await this.configureNetwork();
    await this.runtime.restartNetwork();
    return this.snapshot();
  }
}
