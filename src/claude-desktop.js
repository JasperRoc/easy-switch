import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomic } from './store.js';

const profileId = 'a71322d6-7f51-44d8-93b5-ea515c001001';
const configName = 'claude_desktop_config.json';
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
function object(text) {
  let value;
  try { value = text ? JSON.parse(text.replace(/^\uFEFF/, '')) : {}; }
  catch { throw new Error('Invalid Claude Desktop configuration; the original file was preserved.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude Desktop configuration; the original file was preserved.');
  return value;
}
export function claudeDesktopPaths({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const base = env.SWITCH_CLAUDE_DESKTOP_HOME || (platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : env.XDG_CONFIG_HOME || path.join(home, '.config'));
  function directory(thirdParty) {
    const name = thirdParty ? 'Claude-3p' : 'Claude', exact = path.join(base, name);
    if (platform !== 'win32' || fs.existsSync(exact) || !fs.existsSync(base)) return exact;
    const variant = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('Claude') && entry.name.includes('-3p') === thirdParty).sort((a, b) => a.name.localeCompare(b.name))[0];
    return variant ? path.join(base, variant.name) : exact;
  }
  return { normal: directory(false), thirdParty: directory(true) };
}

// Stable client roles keep provider switches independent of Desktop's startup-only profile.
// These IDs identify routes, not a claim that every upstream offers the named Claude model.
export const desktopRoles = [
  { id: 'claude-sonnet-5', label: 'easy-switch · Sonnet', role: 'default' },
  { id: 'claude-opus-5', label: 'easy-switch · Opus', role: 'default' },
  { id: 'claude-haiku-4-5', label: 'easy-switch · Subagent', role: 'subagent' },
];
export function claudeDesktopModels(provider, alias) {
  const data = desktopRoles.map(({ id, label, role }) => {
    const model = provider.type === 'api' && (provider.claudeModels?.[role] || provider.claudeModels?.default) || id;
    return { id, type: 'model', display_name: label, created_at: '2024-01-01T00:00:00Z', description: `${alias} · ${model}`.slice(0, 100) };
  });
  return { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id };
}

export function activateClaudeDesktop(root, directories, port, token) {
  const recordFile = path.join(root, 'claude-desktop-session.json');
  if (!directories || fs.existsSync(recordFile) || !fs.existsSync(directories.normal)) return;
  const library = path.join(directories.thirdParty, 'configLibrary');
  const profile = {
    inferenceProvider: 'gateway', inferenceGatewayBaseUrl: `http://127.0.0.1:${port}/claude-desktop`,
    inferenceGatewayAuthScheme: 'bearer', inferenceGatewayApiKey: token,
    disableDeploymentModeChooser: true,
    inferenceModels: desktopRoles.map(({ id, label }) => ({ name: id, labelOverride: label })), modelDiscoveryEnabled: true,
  };
  const files = [
    { file: path.join(directories.normal, configName), managed: { deploymentMode: '3p' } },
    { file: path.join(directories.thirdParty, configName), managed: { deploymentMode: '3p' } },
    { file: path.join(library, `${profileId}.json`), managed: profile },
    { file: path.join(library, '_meta.json'), managed: { appliedId: profileId }, meta: true },
  ].map(entry => {
    const original = read(entry.file), before = object(original);
    if (entry.meta) {
      if (before.entries !== undefined && !Array.isArray(before.entries)) throw new Error('Invalid Claude Desktop profile list; the original file was preserved.');
      const entries = [...(before.entries || [])], index = entries.findIndex(item => item.id === profileId);
      const own = { ...(index >= 0 ? entries[index] : {}), id: profileId, name: 'easy-switch' };
      if (index < 0) entries.push(own); else entries[index] = own;
      entry.managed.entries = entries;
    }
    return { ...entry, original, exists: fs.existsSync(entry.file) };
  });
  // Persist every preimage before the first write, so partial activation is recoverable.
  atomic(recordFile, { files });
  for (const entry of files) {
    if (read(entry.file) !== entry.original) throw new Error('Claude Desktop settings changed during startup. Retry.');
    atomic(entry.file, { ...object(entry.original), ...entry.managed });
  }
}
export function restoreClaudeDesktop(recordFile) {
  if (!fs.existsSync(recordFile)) return false;
  const record = JSON.parse(read(recordFile));
  for (const entry of record.files) {
    const current = read(entry.file), settings = object(current), before = object(entry.original);
    for (const [key, value] of Object.entries(entry.managed)) {
      if (entry.meta && key === 'entries') {
        if (!Array.isArray(settings.entries)) continue;
        const ours = value.find(item => item.id === profileId), previous = before.entries?.find(item => item.id === profileId);
        settings.entries = settings.entries.flatMap(item => item.id === profileId && isDeepStrictEqual(item, ours) ? previous ? [previous] : [] : [item]);
        if (!before.entries && !settings.entries.length) delete settings.entries;
      } else if (isDeepStrictEqual(settings[key], value)) {
        if (Object.hasOwn(before, key)) settings[key] = before[key]; else delete settings[key];
      }
    }
    if (read(entry.file) !== current) throw new Error('Claude Desktop settings changed during restoration. Retry.');
    if (!fs.existsSync(entry.file)) continue; // Retain a concurrent user deletion.
    if (isDeepStrictEqual(settings, before)) {
      if (entry.exists) fs.writeFileSync(entry.file, entry.original, { mode: 0o600 });
      else fs.rmSync(entry.file, { force: true });
    } else atomic(entry.file, settings);
  }
  fs.rmSync(recordFile);
  return true;
}
