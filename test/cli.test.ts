import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addProvider, readState, init, aliasName } from '../src/store.js';
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, run: args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SWITCH_HOME: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude-client') }, encoding: 'utf8' }) };
}
test('fd and fd cc isolate provider switching and list priority without credentials', t => {
  const { root, run } = fixture(t), claude = path.join(root, 'claude');
  for (const dir of [root, claude]) for (const alias of ['one', 'two']) addProvider(alias, { type: 'api', baseUrl: 'https://example.test/v1', apiKey: 'PRIVATE_KEY' }, dir);
  assert.equal(run(['two']).status, 0); assert.equal(readState(root).active, 'two'); assert.equal(readState(claude).active, 'one');
  assert.equal(run(['cc', 'two']).status, 0); assert.equal(readState(claude).active, 'two');
  for (const scope of [[], ['cc']]) { const list = run([...scope, 'ls']); assert.equal(list.status, 0); assert.match(list.stdout, /2\. \* two/); assert.doesNotMatch(list.stdout + list.stderr, /PRIVATE_KEY/); }
  assert.equal(run(['rm', 'two']).status, 0); assert.equal(readState(root).active, 'one'); assert.equal(readState(claude).active, 'two');
  assert.equal(run(['cc', 'rm', 'two']).status, 0); assert.equal(readState(claude).active, 'one');
});
test('fd only exposes the requested command set and rejects removed commands without changing providers', t => {
  const { root, run } = fixture(t); init(root); init(path.join(root, 'claude'));
  const original = readState(root), claude = readState(path.join(root, 'claude'));
  for (const name of ['add', 'edit', 'rm', 'ls', 'order', 'cc', 'update', 'uninstall', 'help']) assert.throws(() => aliasName(name));
  const help = run(['help']); assert.equal(help.status, 0);
  for (const command of ['add account <alias>', 'add api <alias>', 'edit <alias>', 'rm <alias>', 'ls', 'order']) {
    assert.ok(help.stdout.includes('fd ' + command)); assert.ok(help.stdout.includes('fd cc ' + command));
  }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).bin), ['fd']);
  for (const args of [['list'], ['current'], ['remove', 'missing'], ['codex', 'ls'], ['claude', 'ls'], ['service', 'status'], ['sync', 'now'], ['model'], ['enable', 'missing'], ['disable', 'missing'], ['order', 'a'], ['add', 'api'], ['add', 'api', 'alias', 'extra'], ['cc', 'update'], ['cc', 'uninstall']]) assert.equal(run(args).status, 1, args.join(' '));
  assert.deepEqual(readState(root), original); assert.deepEqual(readState(path.join(root, 'claude')), claude);
  assert.equal(run(['add', 'api', 'noninteractive']).status, 1);
});
test('fd rm removes only owned credentials and preserves shared or external account directories', t => {
  const { root, run } = fixture(t);
  const owned = path.join(root, 'accounts', 'owned'); fs.mkdirSync(owned, { recursive: true });
  addProvider('owned', { type: 'account', accountHome: owned }, root); assert.equal(run(['rm', 'owned']).status, 0); assert.ok(!fs.existsSync(owned));
  const external = path.join(root, 'external'); fs.mkdirSync(external);
  addProvider('external', { type: 'account', accountHome: external }, root); assert.equal(run(['rm', 'external']).status, 0); assert.ok(fs.existsSync(external));
  const shared = path.join(root, 'accounts', 'shared'); fs.mkdirSync(shared);
  for (const name of ['first', 'second']) addProvider(name, { type: 'account', accountHome: shared }, root);
  assert.equal(run(['rm', 'first']).status, 0); assert.ok(fs.existsSync(shared));
  assert.equal(run(['rm', 'second']).status, 0); assert.ok(!fs.existsSync(shared));
});
test('fd order requires an interactive terminal and preserves selection on failure', t => {
  const { root, run } = fixture(t); addProvider('one', { type: 'api', baseUrl: 'https://example.test', apiKey: 'PRIVATE' }, root);
  const original = readState(root); assert.equal(run(['order']).status, 1); assert.deepEqual(readState(root), original);
});
