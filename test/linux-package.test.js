import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installLauncher, removeLauncher } from '../src/linux-package.js';

test('current-user launcher uses its supported runtime even if the shell node is missing or outdated', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "switch-user-'"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = path.join(directory, '.local', 'bin', 'switch');
  installLauncher(directory);
  const run = spawnSync(launcher, ['help'], { env: { ...process.env, PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /easy-switch/);
  installLauncher(directory); removeLauncher(directory); assert.equal(fs.existsSync(launcher), false);
  fs.writeFileSync(launcher, '# another tool\n');
  assert.throws(() => installLauncher(directory), /another tool/); removeLauncher(directory); assert.equal(fs.readFileSync(launcher, 'utf8'), '# another tool\n');
});

test('Linux discovers the native Codex bundled with a Remote SSH extension when no shell command exists', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-remote-binary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return import('../src/codex-binary.js').then(({ codexBinary }) => {
    const binary = path.join(directory, '.vscode-server', 'extensions', 'openai.chatgpt-26.1021.22027-linux-x64', 'bin', 'linux-x86_64', 'codex');
    fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(codexBinary({ userHome: directory, env: { PATH: '/nonexistent' }, arch: 'x64' }), binary);
    assert.throws(() => codexBinary({ userHome: directory, env: { SWITCH_CODEX_BIN: '/missing', PATH: '' } }), /SWITCH_CODEX_BIN/);
  });
});
