import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { patchedConfig, prepareConfig, restoreConfig, unitText } from '../src/install.js';

test('global configuration keeps comments and unrelated settings, needs no shell environment', () => {
  const original = '# settings\nmodel_provider = "old" # previous\nmodel = "test"\n[mcp_servers.example]\ncommand = "tool"\n';
  const output = patchedConfig(original, 18345, 'local-token');
  const parsed = parse(output);
  assert.match(output, /# settings/);
  assert.equal(parsed.model_provider, 'easy_switch');
  assert.equal(parsed.mcp_servers.example.command, 'tool');
  assert.equal(parsed.model_providers.easy_switch.http_headers.Authorization, 'Bearer local-token');
  assert.equal(parsed.model_providers.easy_switch.env_key, undefined);
  assert.throws(() => patchedConfig(output, 18345, 'token'));
});
test('installation is idempotent, restores exact original, refuses later user edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex'); fs.mkdirSync(codexHome);
  const file = path.join(codexHome, 'config.toml');
  const original = '# original\nmodel="test"\n';
  fs.writeFileSync(file, original);
  prepareConfig(root, codexHome, 18345, 'token').apply();
  const installed = fs.readFileSync(file, 'utf8');
  prepareConfig(root, codexHome, 18345, 'token').apply();
  assert.equal(fs.readFileSync(file, 'utf8'), installed);
  fs.appendFileSync(file, '\n# user edit\n');
  assert.throws(() => restoreConfig(root));
  fs.writeFileSync(file, installed);
  restoreConfig(root);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('complex TOML never silently changes unrelated values', () => {
  const original = 'note = """\nmodel_provider = "fake"\n"""\nmodel_provider = "old"\n';
  assert.throws(() => patchedConfig(original, 18345, 'token'));
});
test('systemd service has stable paths, restart policy, no shell, no secret', () => {
  const unit = unitText('/home/user/a% b', 18345, '/opt/node/bin/node', '/opt/easy switch/src/daemon.js');
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default.target/);
  assert.match(unit, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/easy switch\/src\/daemon.js"\n/);
  assert.match(unit, /a%% b/);
  assert.doesNotMatch(unit, /Bearer/);
});
