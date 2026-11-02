import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomic } from './store.js';

const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const managed = (port, token) => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/claude`, ANTHROPIC_AUTH_TOKEN: token,
  ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
export function activateClaude(root, directory, port, token) {
  const recordFile = path.join(root, 'claude-session.json');
  if (fs.existsSync(recordFile)) return;
  const file = path.join(directory, 'settings.json'), original = read(file);
  const settings = original ? JSON.parse(original) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Claude Code settings.');
  if (settings.env && (typeof settings.env !== 'object' || Array.isArray(settings.env))) throw new Error('Invalid Claude Code env settings.');
  const env = managed(port, token);
  atomic(recordFile, { file, exists: fs.existsSync(file), original, env });
  if (read(file) !== original) { fs.rmSync(recordFile); throw new Error('Claude Code settings changed during startup. Retry.'); }
  atomic(file, { ...settings, env: { ...settings.env, ...env } });
}
export function restoreClaude(recordFile) {
  if (!fs.existsSync(recordFile)) return false;
  const record = JSON.parse(read(recordFile)), current = read(record.file);
  const settings = current ? JSON.parse(current) : {}, before = record.original ? JSON.parse(record.original) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Claude Code settings; the recovery record was retained.');
  for (const [key, value] of Object.entries(record.env)) {
    if (settings.env?.[key] !== value) continue; // Preserve the user's concurrent edits.
    if (Object.hasOwn(before.env || {}, key)) settings.env[key] = before.env[key]; else delete settings.env[key];
  }
  if (!before.env && !Object.keys(settings.env || {}).length) delete settings.env;
  if (read(record.file) !== current) throw new Error('Claude Code settings changed during restoration. Retry.');
  if (isDeepStrictEqual(settings, before)) {
    if (record.exists) { fs.writeFileSync(record.file, record.original, { mode: 0o600 }); }
    else fs.rmSync(record.file, { force: true });
  } else atomic(record.file, settings);
  fs.rmSync(recordFile);
  return true;
}
