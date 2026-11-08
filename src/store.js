import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { claudeModelMapping } from './claude-models.js';

export const home = () => path.resolve(process.env.SWITCH_HOME || path.join(os.homedir(), '.codex-switch'));
const reserved = new Set(['add', 'edit', 'list', 'current', 'help', 'service', 'order', 'update', 'model', 'claude']);
export function aliasName(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || reserved.has(value)) throw new Error('别名须为 1–64 位字母、数字、_、-，且不能是命令名');
  return value;
}
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function readState(root = home()) {
  return JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
}
export function init(root = home()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'state.json');
  try { fs.writeFileSync(file, JSON.stringify({ version: 1, token: crypto.randomBytes(32).toString('hex'), active: null, providers: {} }), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return readState(root);
}
export function update(fn, root = home()) {
  init(root);
  const lock = path.join(root, 'write.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('另一个配置写入正在进行；若此前进程崩溃，请确认后删除 write.lock'); throw e; }
  try {
    const state = readState(root);
    fn(state);
    atomic(path.join(root, 'state.json'), state);
    return state;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function addProvider(alias, provider, root = home()) {
  aliasName(alias);
  return update(s => {
    if (Object.hasOwn(s.providers, alias)) throw new Error('别名已存在');
    const order = providerOrder(s);
    s.providers[alias] = provider;
    s.order = [...order, alias];
    s.active ??= alias;
  }, root);
}
export function providerOrder(state) {
  return state.order || Object.keys(state.providers);
}
export function editProvider(alias, { alias: renamed = alias, baseUrl, apiKey, claudeModels } = {}, root = home()) {
  aliasName(renamed);
  return update(s => {
    const provider = Object.hasOwn(s.providers, alias) ? s.providers[alias] : null;
    if (!provider) throw new Error('Unknown provider.');
    if (renamed !== alias && Object.hasOwn(s.providers, renamed)) throw new Error('That alias already exists.');
    if (provider.type !== 'api' && (baseUrl !== undefined || apiKey !== undefined || claudeModels !== undefined)) throw new Error('Only API providers have a Base URL, API key or model mapping.');
    if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192)) throw new Error('Enter a valid API key.');
    const next = { ...provider, revision: (provider.revision || 0) + 1 };
    if (baseUrl !== undefined) next.baseUrl = baseURL(baseUrl);
    if (apiKey !== undefined) next.apiKey = apiKey.trim();
    if (claudeModels !== undefined) {
      const mapping = claudeModelMapping(claudeModels);
      if (mapping) next.claudeModels = mapping; else delete next.claudeModels;
    }
    s.order = providerOrder(s).map(name => name === alias ? renamed : name);
    delete s.providers[alias]; s.providers[renamed] = next;
    if (s.active === alias) {
      s.active = renamed;
    }
    if (s.lastFailover) for (const key of ['from', 'to']) if (s.lastFailover[key] === alias) s.lastFailover[key] = renamed;
    s.generation = (s.generation || 0) + 1;
    s.manualGeneration = (s.manualGeneration || 0) + 1;
    s.reason = 'manual';
  }, root);
}
export function removeProvider(alias, root = home()) {
  return update(s => {
    if (!Object.hasOwn(s.providers, alias)) throw new Error('未知别名');
    s.order = providerOrder(s).filter(name => name !== alias);
    delete s.providers[alias];
    if (s.active === alias) s.active = s.order[0] || null;
    s.generation = (s.generation || 0) + 1;
    s.manualGeneration = (s.manualGeneration || 0) + 1;
    s.reason = 'manual';
    if (s.lastFailover?.from === alias || s.lastFailover?.to === alias) delete s.lastFailover;
  }, root);
}
export function setOrder(aliases, root = home()) {
  return update(s => {
    if (aliases.length !== Object.keys(s.providers).length ||
        new Set(aliases).size !== aliases.length ||
        aliases.some(alias => !Object.hasOwn(s.providers, alias))) {
      throw new Error('请按优先级列出全部别名，每个恰好一次：switch order <alias> ...');
    }
    s.order = [...aliases];
  }, root);
}
export function activate(alias, root = home()) {
  return update(s => {
    if (!Object.hasOwn(s.providers, alias)) throw new Error('未知别名');
    s.active = alias;
    s.generation = (s.generation || 0) + 1;
    s.manualGeneration = (s.manualGeneration || 0) + 1;
    s.reason = 'manual';
  }, root);
}
export function activateFallback(alias, expectedGeneration, from, status, root = home()) {
  let changed = false;
  update(s => {
    if ((s.generation || 0) !== expectedGeneration || s.active !== from || !Object.hasOwn(s.providers, alias)) return;
    s.active = alias;
    s.generation = (s.generation || 0) + 1;
    s.reason = 'failover';
    s.lastFailover = { from, to: alias, status, at: new Date().toISOString() };
    changed = true;
  }, root);
  return changed;
}
export function baseURL(value) {
  const u = new URL(value.trim() || 'https://api.openai.com/v1');
  if (u.username || u.password || u.search || u.hash) throw new Error('Base URL 不允许包含凭据、查询或片段');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('远程上游必须使用 HTTPS');
  return u.href.replace(/\/+$/, '');
}
export function accountAuth(provider) {
  const auth = JSON.parse(fs.readFileSync(path.join(provider.accountHome, 'auth.json'), 'utf8'));
  if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('账号没有有效的 ChatGPT 登录，需要重新认证');
  return auth;
}
