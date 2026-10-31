import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { createHash } from 'node:crypto';
import { atomic, readState, providerOrder, accountAuth } from '../src/store.js';
import { patchedConfig, writeText } from '../src/install.js';

const provider = 'easy_switch';
const normalized = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => isDeepStrictEqual(normalized(a), normalized(b));
const rootSelector = /^[ \t]*(?:model_provider|"model_provider"|'model_provider')[ \t]*=[^\r\n]*(?:\r?\n|$)/m;
const nativeSettings = [['', 'cli_auth_credentials_store', 'file'], ['', 'forced_login_method', 'chatgpt'], ['features', 'image_generation', true]];
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const hash = text => createHash('sha256').update(text).digest('hex');
function subject(auth) {
  try { return JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url')).sub; } catch { return null; }
}

// Edit only the managed scalar, preserving comments and unrelated settings.
function setting(text, table, key, value) {
  const before = parse(text), expected = normalized(before);
  const target = table ? (expected[table] ??= {}) : expected;
  if (value === undefined) delete target[key]; else target[key] = value;
  const headers = [...text.matchAll(/^[ \t]*\[[^\r\n]*\][ \t]*(?:#[^\r\n]*)?$/gm)];
  const index = table ? headers.findIndex(match => match[0].trim() === `[${table}]`) : -1;
  const start = table ? (index < 0 ? text.length : headers[index].index + headers[index][0].length) : 0;
  const end = table ? (index < 0 ? text.length : headers[index + 1]?.index ?? text.length) : headers[0]?.index ?? text.length;
  const pattern = new RegExp(`^[ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)`, 'm');
  const line = value === undefined ? '' : stringify({ [key]: value });
  const section = text.slice(start, end);
  let result;
  if (pattern.test(section)) result = text.slice(0, start) + section.replace(pattern, line) + text.slice(end);
  else if (value === undefined) result = text;
  else if (table && index < 0) result = `${text}\n[${table}]\n${line}`;
  else result = text.slice(0, start) + '\n' + line + text.slice(start);
  if (!same(parse(result), expected)) throw new Error('Cannot safely update native image settings in this TOML layout.');
  return result;
}

function withNativeSettings(text) {
  for (const [table, key, value] of nativeSettings) text = setting(text, table, key, value);
  return text;
}

export function restoredText(current, record) {
  if (current === record.installed) return record.original;
  if (current === record.original) return current;
  if (record.previous && same(parse(current).model_providers?.[provider] ?? null,
    parse(record.previous.installed).model_providers?.[provider] ?? null))
    return restoredText(current, { ...record, ...record.previous, previous: null });
  if (record.nativeTools) {
    const before = parse(record.original), installed = parse(record.installed);
    for (const [table, key] of nativeSettings) {
      const now = parse(current), value = table ? now[table]?.[key] : now[key];
      if (same(value ?? null, (table ? installed[table]?.[key] : installed[key]) ?? null))
        current = setting(current, table, key, table ? before[table]?.[key] : before[key]);
    }
    if (!before.features && !Object.keys(parse(current).features || {}).length)
      current = current.replace(/^[ \t]*\[features\][ \t]*(?:\r?\n|$)/m, '');
  }
  const before = parse(record.original), active = parse(record.installed), now = parse(current);
  if (!same(now.model_providers?.[provider] ?? null, active.model_providers[provider])) {
    throw new Error('The easy-switch provider was edited. Restore it before exiting; the backup is in desktop-session.json.');
  }
  const expected = normalized(now);
  delete expected.model_providers[provider];
  if (!Object.keys(expected.model_providers).length) delete expected.model_providers;
  if (now.model_provider === provider) {
    if (Object.hasOwn(before, 'model_provider')) expected.model_provider = before.model_provider;
    else delete expected.model_provider;
  }
  // Only remove sections belonging to our provider. Verify the resulting TOML
  // so header-like text inside multiline strings can never silently corrupt it.
  const headers = [...current.matchAll(/^[ \t]*\[[^\r\n]*\][ \t]*(?:#[^\r\n]*)?$/gm)];
  let result = current;
  for (let i = headers.length - 1; i >= 0; i--) {
    if (/^\s*\[model_providers\.(?:easy_switch|"easy_switch"|'easy_switch')(?:\]|\.)/.test(headers[i][0])) {
      let end = headers[i + 1]?.index ?? current.length;
      const lines = current.slice(headers[i].index, end).match(/[^\n]*\n|[^\n]+$/g) || [];
      for (const line of lines.reverse()) {
        if (!/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/.test(line)) break;
        end -= line.length;
      }
      result = result.slice(0, headers[i].index) + result.slice(end);
    }
  }
  if (now.model_provider === provider) {
    result = result.replace(rootSelector, '');
    const originalLine = record.original.match(rootSelector)?.[0];
    if (originalLine) result = originalLine.replace(/\r?\n?$/, '\n') + result;
  }
  if (!same(parse(result), expected)) throw new Error('Cannot safely restore this TOML layout. The original backup has been retained.');
  return result;
}

export function restoreSession(recordFile) {
  if (!fs.existsSync(recordFile)) return false;
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const current = fs.existsSync(record.file) ? fs.readFileSync(record.file, 'utf8') : '';
  const result = restoredText(current, record);
  if ((fs.existsSync(record.file) ? fs.readFileSync(record.file, 'utf8') : '') !== current) throw new Error('Codex configuration changed during restoration. Retry.');
  restoreAuth(record.auth);
  if (!record.exists && !result.trim()) fs.rmSync(record.file, { force: true });
  else writeText(record.file, result);
  fs.rmSync(recordFile, { force: true });
  return true;
}

function restoreAuth(auth) {
  if (!auth) return;
  const current = read(auth.file);
  let managed = current === auth.installed;
  try {
    const now = JSON.parse(current), installed = JSON.parse(auth.installed);
    const samePerson = subject(installed) ? subject(now) === subject(installed) :
      installed.tokens.id_token ? now.tokens?.id_token === installed.tokens.id_token : now.tokens?.access_token === installed.tokens.access_token;
    managed ||= now.auth_mode !== 'apikey' && now.tokens?.account_id === installed.tokens.account_id && samePerson;
    // Preserve a native refresh in our account cache without reverting a concurrent login.
    if (managed && auth.sourceFile !== auth.file && hash(read(auth.sourceFile)) === auth.sourceHash && current !== auth.installed)
      atomic(auth.sourceFile, now);
  } catch {}
  if (!managed) return; // A separate Codex sign-in belongs to the user.
  if (auth.exists) writeText(auth.file, auth.original); else fs.rmSync(auth.file, { force: true });
}

function subscription(root) {
  const state = readState(root);
  for (const alias of [state.active, ...providerOrder(state)]) {
    const provider = state.providers[alias];
    if (provider?.type !== 'account') continue;
    try { return { provider, auth: accountAuth(provider) }; } catch {}
  }
}

// Adding the first subscription also enables client tools; provider switching
// continues to happen inside the proxy and never replaces a running turn.
export function syncSession(root, codexHome) {
  const recordFile = path.join(root, 'desktop-session.json');
  if (!fs.existsSync(recordFile)) return false;
  const record = JSON.parse(read(recordFile));
  if (record.auth && !Object.values(readState(root).providers).some(provider =>
    provider.type === 'account' && path.join(provider.accountHome, 'auth.json') === record.auth.sourceFile)) {
    const current = read(record.file), config = parse(record.installed).model_providers.easy_switch;
    const port = Number(new URL(config.base_url).port), token = config.http_headers['X-Easy-Switch-Token'];
    const next = patchedConfig(restoredText(current, record), port, token);
    restoreAuth(record.auth);
    const replacement = { ...record, installed: patchedConfig(record.original, port, token), nativeTools: false,
      previous: { installed: record.installed, nativeTools: record.nativeTools } };
    delete replacement.auth;
    atomic(recordFile, replacement); writeText(record.file, next);
    return syncSession(root, codexHome);
  }
  if (record.nativeTools) return true;
  const selected = subscription(root);
  if (!selected) return false;
  const current = read(record.file), authFile = path.join(codexHome, 'auth.json');
  const config = parse(record.installed).model_providers.easy_switch;
  const port = Number(new URL(config.base_url).port), token = readState(root).token;
  const installed = withNativeSettings(patchedConfig(record.original, port, token, true));
  const next = withNativeSettings(patchedConfig(restoredText(current, record), port, token, true));
  const originalAuth = read(authFile);
  const auth = { ...selected.auth, auth_mode: 'chatgpt', OPENAI_API_KEY: null };
  const authRecord = { file: authFile, exists: fs.existsSync(authFile), original: originalAuth,
    installed: JSON.stringify(auth, null, 2) + '\n', sourceFile: path.join(selected.provider.accountHome, 'auth.json') };
  authRecord.sourceHash = hash(read(authRecord.sourceFile));
  atomic(recordFile, { ...record, installed, nativeTools: true, auth: authRecord,
    previous: { installed: record.installed, nativeTools: record.nativeTools } });
  if (read(record.file) !== current || read(authFile) !== originalAuth) throw new Error('Codex settings changed while enabling native images. Retry.');
  writeText(authFile, authRecord.installed);
  writeText(record.file, next);
  return true;
}

export function activateSession(root, codexHome, port, token) {
  const recordFile = path.join(root, 'desktop-session.json');
  if (fs.existsSync(recordFile)) throw new Error('A desktop configuration session is already active.');
  const file = path.join(codexHome, 'config.toml');
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : '';
  // Existing native subscriptions need only tool settings. Otherwise a managed,
  // recoverable sign-in is installed from an account the user added to this app.
  let nativeAuth = false;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
    nativeAuth = auth.auth_mode !== 'apikey' && !auth.OPENAI_API_KEY && !!(auth.tokens?.access_token && auth.tokens?.account_id);
  } catch {}
  const installed = nativeAuth ? withNativeSettings(patchedConfig(original, port, token, true)) : patchedConfig(original, port, token);
  atomic(recordFile, { file, exists, original, installed, nativeTools: nativeAuth });
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== original) {
    fs.rmSync(recordFile, { force: true });
    throw new Error('Codex configuration changed during startup. Retry.');
  }
  writeText(file, installed);
  syncSession(root, codexHome);
}
