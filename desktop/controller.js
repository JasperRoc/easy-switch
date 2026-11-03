import fs from 'node:fs';
import path from 'node:path';
import { init, aliasName, addProvider, editProvider, removeProvider, activate, readState, providerOrder, setOrder, setModel, baseURL, accountAuth, atomic } from '../src/store.js';
import { createReauth, expired } from '../src/auth.js';
import { codexModels, discoverModels, discoverClaudeModels } from '../src/catalog.js';
import { claudeHome as defaultClaudeHome, claudeAuth, claudeExpired, existingClaudeAuth, startClaudeLogin, removeClaudeLogin } from '../src/claude-auth.js';
import { randomUUID } from 'node:crypto';
import { imageEligible } from '../src/images.js';
import { saveNetwork, networkEnvironment } from '../src/network.js';
import { detectSystemProxy, desktopNetworkSettings, proxyEnvironment, publicProxyURL } from './network.js';
import { DesktopRuntime, protectDirectory } from './runtime.js';
import { existingProvider } from './import.js';
import { SubscriptionUsage } from './usage.js';
import { codexResetCredits } from './reset-credits.js';

export class DesktopController {
  constructor({ root, codexHome, claudeHome = defaultClaudeHome(), binary, port = 18345, guardExec, env = process.env, detectProxy = detectSystemProxy, resetRequest = codexResetCredits }) {
    Object.assign(this, { root, codexHome, binary });
    this.originalEnv = { ...env }; this.detectProxy = detectProxy; this.detectedProxy = {};
    protectDirectory(root);
    this.login = null; this.catalog = null;
    this.reauth = createReauth();
    const prompt = this.reauth.prompt;
    this.reauth.prompt = provider => Object.values(readState(root).providers).some(item => item.accountHome === provider.accountHome)
      ? prompt(provider) : Promise.resolve('The provider was removed. Retry with the selected provider.');
    this.runtime = new DesktopRuntime({ root, codexHome, claudeHome, port, reauth: this.reauth, guardExec,
      claudeReauth: alias => this.startClaudeSignIn(alias).catch(() => {}) });
    this.usage = new SubscriptionUsage({ root, refreshAuth: (provider, signal) => codexModels({ binary, provider, signal }) });
    this.preferencesFile = path.join(root, 'desktop.json');
    this.resetRequest = resetRequest; this.resetPending = new Map();
  }
  get client() { return this.preferences().client || 'codex'; }
  get providerRoot() { return this.client === 'claude' ? path.join(this.root, 'claude') : this.root; }
  get currentLogin() { return this.client === 'claude' ? this.claudeLogin : this.login; }
  clientSelection(client) {
    if (!['codex', 'claude'].includes(client)) throw new Error('Choose Codex or Claude Code.');
    this.setPreferences({ client }); this.catalog = null; return this.snapshot();
  }
  preferences() {
    try { return JSON.parse(fs.readFileSync(this.preferencesFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  setPreferences(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const valid = key === 'client' ? ['codex', 'claude'].includes(value) : key === 'language' ? ['en', 'zh-CN'].includes(value) : key === 'theme' ? ['system', 'light', 'dark'].includes(value) : key === 'startAtLogin' && typeof value === 'boolean';
      if (!valid) throw new Error('Invalid desktop preference.');
    }
    atomic(this.preferencesFile, { ...this.preferences(), ...patch });
  }
  async start() {
    process.env.SWITCH_CODEX_BIN = this.binary;
    await this.configureNetwork();
    this.usage.closed = false;
    await this.runtime.start();
  }
  resetCards(alias) {
    if (this.client !== 'codex') throw new Error('Reset cards are available for Codex subscriptions only.');
    const provider = readState(this.root).providers[aliasName(alias)];
    if (provider?.type !== 'account') throw new Error('Choose a subscription account.');
    return this.resetRequest({ binary: this.binary, provider });
  }
  async consumeReset({ alias, creditId, idempotencyKey } = {}) {
    if (this.client !== 'codex') throw new Error('Reset cards are available for Codex subscriptions only.');
    const provider = readState(this.root).providers[aliasName(alias)];
    if (provider?.type !== 'account') throw new Error('Choose a subscription account.');
    if (typeof creditId !== 'string' || !creditId.trim() || typeof idempotencyKey !== 'string') throw new Error('Choose a reset card and retry.');
    if (this.resetPending.has(alias)) throw new Error('A reset is already in progress for this account.');
    const operation = this.resetRequest({ binary: this.binary, provider, creditId, idempotencyKey });
    this.resetPending.set(alias, operation);
    try {
      const result = await operation;
      // Refresh both authoritative card details and quota after any outcome.
      const cards = await this.resetCards(alias).catch(() => null);
      if (this.runtime.active) {
        await this.usage.entries.get(alias)?.pending;
        this.usage.snapshot(readState(this.root), alias);
        await this.usage.entries.get(alias)?.pending;
      }
      return { ...result, cards };
    } finally { this.resetPending.delete(alias); }
  }
  async stop() { await this.runtime.stop(); this.usage.close(); this.reauth.close(); this.claudeLogin?.cancel?.(); }
  snapshot({ usage: includeUsage = true, sessions: includeSessions = true } = {}) {
    const client = this.client, state = init(this.providerRoot);
    const usage = client === 'codex' && this.runtime.active && includeUsage ? this.usage.snapshot(state) : {};
    let freeImages = false;
    const providers = providerOrder(state).map(alias => {
      const provider = state.providers[alias];
      let needsLogin = false;
      if (provider.type === 'account') {
        try { const auth = client === 'claude' ? claudeAuth(provider) : accountAuth(provider); needsLogin = client === 'claude' ? claudeExpired(auth) && !auth.refreshToken : expired(auth); if (client === 'codex' && !imageEligible(auth)) freeImages = true; }
        catch { needsLogin = true; }
      }
      return { alias, type: provider.type, revision: provider.revision || 0, baseUrl: provider.baseUrl || '', active: alias === state.active, needsLogin, usage: usage[alias] || null };
    });
    const sessions = includeSessions ? client === 'codex' ? this.runtime.sessions.snapshot(state)
      : this.runtime.claudeSessions.snapshot(state).filter(session => session.activeRequests > 0).map(session => ({ ...session, title: 'Claude Code · ' + session.id.slice(0, 8) })) : [];
    const login = this.currentLogin;
    return { client, running: !!this.runtime.server && this.runtime.active, providers, active: state.active, model: client === 'claude' && state.modelSelectionAlias && state.modelSelectionAlias !== state.active ? null : state.modelSelection || null,
      lastFailover: state.lastFailover || null, login: login && { alias: login.alias, phase: login.phase, message: login.message, url: login.url, code: login.code, codeRequired: !!login.codeRequired },
      imageTools: client === 'codex' && !!this.runtime.imageTools, imageToolsBlocked: this.runtime.active && freeImages && !this.runtime.imageTools, activeRequests: this.runtime.activeRequests, sessions, sessionsUnavailable: client === 'codex' && this.runtime.sessions.unavailable, preferences: this.preferences() };
  }
  switchProvider(alias) { activate(aliasName(alias), this.providerRoot); this.catalog = null; return this.snapshot(); }
  order(aliases) { setOrder(aliases, this.providerRoot); return this.snapshot(); }
  edit({ original, alias, url, key }) {
    const provider = readState(this.providerRoot).providers[original];
    if (!provider) throw new Error('Unknown provider.');
    const patch = { alias };
    if (provider.type === 'api') {
      if (url !== undefined && this.apiURL(url) !== provider.baseUrl) patch.baseUrl = this.apiURL(url);
      if (key?.trim()) patch.apiKey = key;
    }
    editProvider(original, patch, this.providerRoot); this.catalog = null;
    const login = this.currentLogin; if (login?.alias === original) login.alias = alias;
    return this.snapshot();
  }
  async remove(alias) {
    const client = this.client, root = this.providerRoot, provider = readState(root).providers[alias];
    if (!provider) throw new Error('Unknown provider.');
    if (client === 'claude' && provider.type === 'account' && path.dirname(path.resolve(provider.accountHome)) === path.join(root, 'accounts')) {
      if (this.claudeLogin?.alias === alias) this.claudeLogin.cancel?.();
      await removeClaudeLogin(provider.accountHome);
    }
    removeProvider(alias, root); this.catalog = null;
    this.runtime.syncTools();
    if (provider.type === 'account') {
      if (client === 'codex') { this.reauth.cancel(provider); if (this.login?.alias === alias) this.login = null; }
      else if (this.claudeLogin?.alias === alias) { this.claudeLogin.cancel?.(); this.claudeLogin = null; }
      const owned = path.resolve(provider.accountHome);
      if (path.dirname(owned) === path.join(root, 'accounts') && fs.existsSync(owned) && !fs.lstatSync(owned).isSymbolicLink() &&
          fs.realpathSync(path.dirname(owned)) === path.join(fs.realpathSync(root), 'accounts') &&
          !Object.values(readState(root).providers).some(item => item.accountHome === provider.accountHome)) fs.rmSync(owned, { recursive: true, force: true });
    }
    return this.snapshot();
  }
  apiURL(url = '') { return baseURL(url.trim() || (this.client === 'claude' ? 'https://api.anthropic.com' : '')); }
  addAPI({ alias, url = '', key }) {
    aliasName(alias);
    if (typeof key !== 'string' || !key.trim() || key.length > 8192) throw new Error('Enter a valid API key.');
    addProvider(alias, { type: 'api', baseUrl: this.apiURL(url), apiKey: key.trim() }, this.providerRoot);
    this.runtime.syncClaude();
    return this.snapshot();
  }
  async startLogin(alias) {
    if (this.client === 'claude') return this.startClaudeSignIn(alias);
    aliasName(alias);
    if (this.login && ['starting', 'pending'].includes(this.login.phase)) throw new Error('Finish the current sign-in first.');
    const state = init(this.root), existing = state.providers[alias];
    if (existing && existing.type !== 'account') throw new Error('That alias belongs to an API provider.');
    const accountHome = existing?.accountHome || path.join(this.root, 'accounts', randomUUID());
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
        this.runtime.syncTools();
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
  async startClaudeSignIn(alias) {
    aliasName(alias);
    if (this.claudeLogin && ['starting', 'pending'].includes(this.claudeLogin.phase)) return this.snapshot();
    const root = path.join(this.root, 'claude'), existing = init(root).providers[alias];
    if (existing && existing.type !== 'account') throw new Error('That alias belongs to an API provider.');
    const accountHome = existing?.accountHome || path.join(root, 'accounts', randomUUID());
    const login = startClaudeLogin({ directory: accountHome }); login.alias = alias; this.claudeLogin = login;
    login.completed.then(success => {
      if (!success) return;
      try {
        if (!existing) addProvider(login.alias, { type: 'account', accountHome }, root);
        this.catalog = null; this.runtime.syncClaude();
      } catch { login.phase = 'failed'; login.message = 'That alias already exists.'; }
    });
    await login.ready; return this.snapshot();
  }
  submitLogin(code) {
    if (this.client !== 'claude' || !this.claudeLogin?.codeRequired) throw new Error('Start Claude subscription sign-in first.');
    this.claudeLogin.submit(code); return this.snapshot();
  }
  existingLogin() {
    if (this.client === 'claude') return this.existingClaudeLogin();
    const provider = existingProvider({ codexHome: this.codexHome, root: this.root, env: this.originalEnv });
    let alias = String(provider.name).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 48) || 'codex-import';
    try { aliasName(alias); } catch { alias = 'codex-import'; }
    const state = init(this.root), suggested = alias; let suffix = 2;
    while (state.providers[alias]) alias = `${suggested}-${suffix++}`;
    return { type: provider.type, baseUrl: provider.baseUrl || '', alias };
  }
  importLogin(alias) {
    if (this.client === 'claude') return this.importClaudeLogin(alias);
    aliasName(alias);
    const provider = existingProvider({ codexHome: this.codexHome, root: this.root, env: this.originalEnv });
    const state = init(this.root);
    if (state.providers[alias]) throw new Error('That alias already exists.');
    if (provider.type === 'api') return this.addAPI({ alias, url: provider.baseUrl, key: provider.apiKey });
    const accountHome = path.join(this.root, 'accounts', randomUUID());
    atomic(path.join(accountHome, 'auth.json'), provider.auth);
    addProvider(alias, { type: 'account', accountHome }, this.root);
    this.runtime.syncTools();
    return this.snapshot();
  }
  async readExistingClaude() {
    const file = path.join(this.runtime.claudeHome, 'settings.json');
    let settings = {};
    const recordFile = path.join(this.root, 'claude-session.json');
    if (fs.existsSync(recordFile)) {
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      settings = record.original ? JSON.parse(record.original) : {};
    } else if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const env = { ...this.originalEnv, ...settings.env };
    const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
    if (apiKey?.startsWith('sk-ant-oat01-')) return { type: 'account', auth: { accessToken: apiKey, expiresAt: null, scopes: ['user:inference'] } };
    if (apiKey) return { type: 'api', baseUrl: baseURL(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'), apiKey };
    if (env.CLAUDE_CODE_OAUTH_TOKEN) return { type: 'account', auth: { accessToken: env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: null, scopes: ['user:inference'] } };
    return { type: 'account', auth: await existingClaudeAuth(this.runtime.claudeHome) };
  }
  async existingClaudeLogin() {
    const provider = await this.readExistingClaude(), state = init(path.join(this.root, 'claude'));
    let alias = 'claude-import', suffix = 2;
    while (state.providers[alias]) alias = `claude-import-${suffix++}`;
    return { alias, type: provider.type, baseUrl: provider.baseUrl || '' };
  }
  async importClaudeLogin(alias) {
    aliasName(alias);
    const root = path.join(this.root, 'claude'), state = init(root);
    if (state.providers[alias]) throw new Error('That alias already exists.');
    const provider = await this.readExistingClaude();
    if (provider.type === 'api') addProvider(alias, provider, root);
    else {
      const accountHome = path.join(root, 'accounts', randomUUID());
      atomic(path.join(accountHome, 'oauth.json'), provider.auth);
      addProvider(alias, { type: 'account', accountHome }, root);
    }
    this.runtime.syncClaude(); return this.snapshot();
  }
  async models() {
    const root = this.providerRoot, state = readState(root), provider = state.providers[state.active];
    if (!provider) throw new Error('Add a provider first.');
    const result = this.client === 'claude' ? await discoverClaudeModels(provider, this.root) : await discoverModels(provider, this.root, { catalogImpl: account => codexModels({ binary: this.binary, provider: account }) });
    if (this.providerRoot !== root || readState(root).generation !== state.generation) throw new Error('The provider changed while loading models. Refresh the catalog again.');
    this.catalog = { alias: state.active, ...result };
    return result;
  }
  model(selection, sessionId) {
    const root = this.providerRoot;
    if (sessionId !== undefined && !this.snapshot({ usage: false }).sessions.some(session => session.id === sessionId)) throw new Error('Choose a session observed by this app first.');
    if (!selection) { setModel(null, root, undefined, sessionId); return this.snapshot(); }
    const entry = this.catalog?.models.find(model => model.id === selection.model);
    if (!(selection.manual === true && selection.effort === null) && (!entry || (selection.effort !== null && !entry.efforts.includes(selection.effort)))) throw new Error('Reload the model catalog and choose a supported effort.');
    setModel(selection, root, selection.manual ? readState(root).active : this.catalog.alias, sessionId);
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
      localProxy: { url: `http://127.0.0.1:${this.runtime.port}${this.client === 'claude' ? '/claude' : '/v1'}`, running: !!this.runtime.server && this.runtime.active } };
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
