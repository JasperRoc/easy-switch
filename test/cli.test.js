import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addProvider, readState, init } from '../src/store.js';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI switches persistent selection; list hides credentials; unknown names preserve selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addProvider('one', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET_ONE' }, root);
  addProvider('two', { type: 'api', baseUrl: 'https://example.org/v1', apiKey: 'SECRET_TWO' }, root);
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWITCH_HOME: root }, encoding: 'utf8' });
  assert.equal(run(['two']).status, 0);
  assert.equal(readState(root).active, 'two');
  assert.equal(run(['current']).stdout, 'Codex: two\nClaude: 尚未选择\n');
  assert.equal(run(['codex', 'current']).stdout, 'two\n');
  const list = run(['list']);
  assert.match(list.stdout, /\* two/);
  assert.doesNotMatch(list.stdout + list.stderr, /SECRET/);
  assert.equal(run(['missing']).status, 1);
  assert.equal(readState(root).active, 'two');
  assert.equal(run(['add', 'api', 'noninteractive']).status, 1);
});

test('explicit client commands isolate selection, deletion, priorities and current output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-cli-clients-')), claude = path.join(root, 'claude');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = { type: 'api', baseUrl: 'https://example.test/v1', apiKey: 'PRIVATE_FIXTURE' };
  for (const directory of [root, claude]) for (const alias of ['one', 'two']) addProvider(alias, provider, directory);
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWITCH_HOME: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude-client') }, encoding: 'utf8' });
  assert.equal(run(['codex', 'two']).status, 0);
  assert.equal(run(['claude', 'current']).stdout, 'one\n');
  assert.equal(run(['current']).stdout, 'Codex: two\nClaude: one\n');
  assert.equal(run(['claude', 'two']).status, 0);
  assert.equal(run(['codex', 'remove', 'two']).status, 0);
  assert.equal(readState(root).active, 'one'); assert.equal(readState(claude).active, 'two');
  assert.deepEqual(readState(root).order, ['one']);
  assert.equal(run(['claude', 'remove', 'two']).status, 0);
  assert.equal(run(['claude', 'current']).stdout, 'one\n');
  const before = readState(claude);
  for (const args of [['codex', 'remove'], ['claude', 'remove', 'missing'], ['codex', 'remove', 'one', 'extra']]) assert.equal(run(args).status, 1);
  assert.deepEqual(readState(claude), before);
  assert.equal(run(['claude', 'remove', 'one']).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'claude-client', 'settings.json')), false, 'deleting the last Claude provider restores its client settings');
  assert.equal(run(['current']).stdout, 'Codex: one\nClaude: 尚未选择\n');
  assert.doesNotMatch(run(['codex', 'list']).stdout + run(['claude', 'list']).stdout, /PRIVATE_FIXTURE/);
});

test('CLI deletion removes owned login copies while preserving external, shared and symlinked account directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-cli-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath, [cli, 'codex', 'remove', ...args], { env: { ...process.env, SWITCH_HOME: root }, encoding: 'utf8' });
  const owned = path.join(root, 'accounts', 'owned'); fs.mkdirSync(owned, { recursive: true }); fs.writeFileSync(path.join(owned, 'auth.json'), 'fixture');
  addProvider('owned', { type: 'account', accountHome: owned }, root);
  assert.equal(run(['owned']).status, 0); assert.equal(fs.existsSync(owned), false);
  const external = path.join(root, 'external'); fs.mkdirSync(external);
  addProvider('external', { type: 'account', accountHome: external }, root);
  assert.equal(run(['external']).status, 0); assert.equal(fs.existsSync(external), true);
  const shared = path.join(root, 'accounts', 'shared'); fs.mkdirSync(shared);
  for (const alias of ['first', 'second']) addProvider(alias, { type: 'account', accountHome: shared }, root);
  assert.equal(run(['first']).status, 0); assert.equal(fs.existsSync(shared), true);
  assert.equal(run(['second']).status, 0); assert.equal(fs.existsSync(shared), false);
  if (process.platform !== 'win32') {
    const linked = path.join(root, 'accounts', 'linked'); fs.symlinkSync(external, linked);
    addProvider('linked', { type: 'account', accountHome: linked }, root);
    assert.equal(run(['linked']).status, 0); assert.equal(fs.existsSync(linked), true); assert.equal(fs.existsSync(external), true);
  }
});

test('public CLI has no obsolete commands or secondary executable', () => {
  const result = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  assert.doesNotMatch(result.stdout, /switch (?:install|login|run|serve)|codex-switch 命令/);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.deepEqual(Object.keys(pkg.bin), ['switch']);
  assert.equal(pkg.license, 'MIT');
});

test('order persists a complete permutation, preserves active selection, and appends new aliases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET' };
  for (const alias of ['a', 'b', 'c']) addProvider(alias, provider, root);
  const run = aliases => spawnSync(process.execPath, [cli, 'order', ...aliases], { env: { ...process.env, SWITCH_HOME: root }, encoding: 'utf8' });
  assert.equal(run([]).status, 1); // Interactive editor requires a TTY.
  assert.equal(run(['c', 'a', 'b']).status, 0);
  const saved = readState(root);
  assert.equal(saved.active, 'a');
  assert.deepEqual(saved.order, ['c', 'a', 'b']);
  for (const invalid of [['a'], ['a', 'a', 'c'], ['a', 'b', 'unknown']]) {
    assert.equal(run(invalid).status, 1);
    assert.deepEqual(readState(root), saved);
  }
  addProvider('d', provider, root);
  const list = spawnSync(process.execPath, [cli, 'list'], { env: { ...process.env, SWITCH_HOME: root }, encoding: 'utf8' });
  assert.deepEqual(list.stdout.trim().split('\n').map(line => line.split('\t')[0]), ['1.   c', '2. * a', '3.   b', '4.   d']);
});


test('removed model commands reject calls without changing either client configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-no-model-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  init(root); init(path.join(root, 'claude'));
  const before = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  const claudeBefore = fs.readFileSync(path.join(root, 'claude', 'state.json'), 'utf8');
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWITCH_HOME: root }, encoding: 'utf8' });
  assert.doesNotMatch(run(['help']).stdout, /switch model/);
  for (const args of [['model'], ['model', 'reset'], ['model', 'some-model'], ['claude', 'model']]) assert.equal(run(args).status, 1);
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(root, 'claude', 'state.json'), 'utf8'), claudeBefore);
});
