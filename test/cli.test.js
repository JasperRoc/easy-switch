import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addProvider, readState } from '../src/store.js';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI switches persistent selection; list hides credentials; unknown names preserve selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addProvider('one', { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET_ONE' }, root);
  addProvider('two', { type: 'api', baseUrl: 'https://example.org/v1', apiKey: 'SECRET_TWO' }, root);
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWITCH_HOME: root }, encoding: 'utf8' });
  assert.equal(run(['two']).status, 0);
  assert.equal(readState(root).active, 'two');
  assert.match(run(['current']).stdout, /^two/);
  const list = run(['list']);
  assert.match(list.stdout, /\* two/);
  assert.doesNotMatch(list.stdout + list.stderr, /SECRET/);
  assert.equal(run(['missing']).status, 1);
  assert.equal(readState(root).active, 'two');
  assert.equal(run(['add', 'api', 'noninteractive']).status, 1);
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
