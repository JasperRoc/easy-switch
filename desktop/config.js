import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { atomic } from '../src/store.js';
import { patchedConfig, writeText } from '../src/install.js';

const provider = 'easy_switch';
const normalized = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => isDeepStrictEqual(normalized(a), normalized(b));
const rootSelector = /^[ \t]*(?:model_provider|"model_provider"|'model_provider')[ \t]*=[^\r\n]*(?:\r?\n|$)/m;

export function restoredText(current, record) {
  if (current === record.installed) return record.original;
  if (current === record.original) return current;
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
  if (!record.exists && !result.trim()) fs.rmSync(record.file, { force: true });
  else writeText(record.file, result);
  fs.rmSync(recordFile, { force: true });
  return true;
}

export function activateSession(root, codexHome, port, token) {
  const recordFile = path.join(root, 'desktop-session.json');
  if (fs.existsSync(recordFile)) throw new Error('A desktop configuration session is already active.');
  const file = path.join(codexHome, 'config.toml');
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : '';
  const installed = patchedConfig(original, port, token);
  atomic(recordFile, { file, exists, original, installed });
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== original) {
    fs.rmSync(recordFile, { force: true });
    throw new Error('Codex configuration changed during startup. Retry.');
  }
  writeText(file, installed);
}
