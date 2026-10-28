import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const home = () => path.resolve(process.env.SWITCH_HOME || path.join(os.homedir(), '.codex-switch'));
const reserved = new Set(['add', 'list', 'current', 'help', 'service', 'order', 'update', 'model']);
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
export function setModel(selection, root = home(), expectedAlias) {
  if (selection && (typeof selection.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(selection.model) ||
      (selection.effort !== null && (typeof selection.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(selection.effort))))) {
    throw new Error('无效的模型或 effort');
  }
  return update(s => {
    if (expectedAlias !== undefined && s.active !== expectedAlias) throw new Error('选择期间上游已变化，请重新执行 switch model');
    if (selection) s.modelSelection = { model: selection.model, effort: selection.effort };
    else delete s.modelSelection;
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
