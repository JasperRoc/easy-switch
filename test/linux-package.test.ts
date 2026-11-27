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
  const launcher = path.join(directory, '.local', 'bin', 'fd');
  installLauncher(directory);
  const run = spawnSync(launcher, ['help'], { env: { ...process.env, PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /fluid/);
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
    assert.equal(codexBinary({ userHome: directory, env: { PATH: '/nonexistent' }, arch: 'x64', platform: 'linux' }), binary);
    assert.equal(codexBinary({ userHome: directory, env: { SWITCH_CODEX_BIN: '/missing', PATH: '' }, arch: 'x64', platform: 'linux' }), binary);
  });
});

test('Codex lookup recovers stale extension paths and resolves native Windows npm packages', async t => {
  const { codexBinary } = await import('../src/codex-binary.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-codex-locator-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const extension = path.join(directory, '.vscode-server', 'extensions', 'openai.chatgpt-26.1125.1-linux-x64', 'bin', 'linux-x86_64', 'codex');
  fs.mkdirSync(path.dirname(extension), { recursive: true }); fs.writeFileSync(extension, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(codexBinary({ userHome: directory, platform: 'linux', arch: 'x64', env: { PATH: '', SWITCH_CODEX_BIN: '/removed/old/codex' } }), extension);
  const npm = path.join(directory, 'AppData', 'Roaming', 'npm');
  const native = path.join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
  fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, 'fixture', { mode: 0o755 });
  fs.writeFileSync(path.join(npm, 'codex.cmd'), '@echo fixture');
  assert.equal(codexBinary({ userHome: directory, platform: 'win32', arch: 'x64', env: { PATH: '', APPDATA: path.dirname(npm) } }), native);
});

test('Codex lookup finds Node version-manager installations without a shell environment', async t => {
  const { codexBinary } = await import('../src/codex-binary.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-codex-nvm-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, '.nvm', 'versions', 'node', 'v22.23.5', 'bin', 'codex');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(codexBinary({ userHome: directory, platform: 'linux', arch: 'x64', env: { PATH: '' } }), binary);
});

test('model metadata selects the installed Codex matching the requesting client rather than the default CLI', { skip: process.platform === 'win32' }, async t => {
  const { codexBinary, codexExecutableForVersion } = await import('../src/codex-binary.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-client-versions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(directory, '.local', 'bin', 'codex');
  const extension = path.join(directory, '.vscode-server', 'extensions', 'openai.chatgpt-26.1127.1-linux-x64', 'bin', 'linux-x86_64', 'codex');
  const write = (file, version) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o755 }); };
  write(cli, '0.170.0'); write(extension, '0.172.0');
  const options = { userHome: directory, platform: 'linux', arch: 'x64', env: { PATH: '', SWITCH_CODEX_BIN: cli } };
  assert.equal(codexBinary(options), cli);
  assert.equal(await codexExecutableForVersion(cli, '0.172.0', options), extension);
  assert.equal(await codexExecutableForVersion(cli, '0.170.0', options), cli);
  assert.equal(await codexExecutableForVersion(cli, '0.999.0', options), undefined, 'never substitute another client version');
  write(extension, '0.173.0-preview');
  assert.equal(await codexExecutableForVersion(cli, '0.173.0', options), extension, 'upgraded binaries invalidate version metadata');
});
