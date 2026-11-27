import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createReauth, expired } from '../src/auth.js';
import { atomic, accountAuth } from '../src/store.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-auth-'));
  const provider = { accountHome: path.join(root, 'personal') };
  atomic(path.join(provider.accountHome, 'auth.json'), { tokens: { access_token: 'old', account_id: 'same' } });
  const children = [];
  const manager = createReauth({ ...options, spawnImpl: (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push({ child, opts });
    assert.deepEqual(args, ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']);
    return child;
  } });
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { provider, manager, children };
}
test('expired JWT detection leaves opaque tokens to upstream validation', () => {
  const jwt = 'x.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.x';
  assert.equal(expired({ tokens: { access_token: jwt } }), true);
  assert.equal(expired({ tokens: { access_token: 'opaque' } }), false);
});
test('concurrent authentication shares one process and exposes only verification data', async t => {
  const { provider, manager, children } = fixture(t);
  const a = manager.prompt(provider); const b = manager.prompt(provider);
  assert.equal(children.length, 1);
  const { child, opts } = children[0];
  child.stdout.write('SECRET_ACCESS_TOKEN\nhttps://auth.openai.com/codex/');
  child.stdout.write('device\nABCD-12345\n');
  const messages = await Promise.all([a, b]);
  assert.equal(messages[0], messages[1]);
  assert.match(messages[0], /ABCD-12345/);
  assert.doesNotMatch(messages[0], /SECRET/);
  atomic(path.join(opts.env.CODEX_HOME, 'auth.json'), { tokens: { access_token: 'new', account_id: 'same' } });
  child.emit('close', 0);
  assert.equal(accountAuth(provider).tokens.access_token, 'new');
  assert.equal(fs.existsSync(opts.env.CODEX_HOME), false);
});
test('different account does not overwrite original credentials', async t => {
  const { provider, manager, children } = fixture(t);
  const prompt = manager.prompt(provider);
  const { child, opts } = children[0];
  atomic(path.join(opts.env.CODEX_HOME, 'auth.json'), { tokens: { access_token: 'other', account_id: 'other' } });
  child.emit('close', 0);
  assert.match(await prompt, /Original credentials were preserved/);
  assert.equal(accountAuth(provider).tokens.access_token, 'old');
});
test('authentication timeout stops child and preserves old credentials', async t => {
  const { provider, manager, children } = fixture(t, { timeoutMs: 10, promptWaitMs: 100 });
  assert.match(await manager.prompt(provider), /timed out/);
  assert.equal(children[0].child.killed, true);
  assert.equal(accountAuth(provider).tokens.access_token, 'old');
});
test('spawn failures do not expose child diagnostics', async t => {
  const { provider, manager, children } = fixture(t);
  const prompt = manager.prompt(provider);
  children[0].child.emit('error', new Error('SECRET'));
  assert.match(await prompt, /Unable to start/);
});

test('same workspace with a different user cannot replace credentials', async t => {
  const { provider, manager, children } = fixture(t);
  const jwt = sub => 'x.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.x';
  atomic(path.join(provider.accountHome, 'auth.json'), { tokens: { access_token: 'old', id_token: jwt('original'), account_id: 'same' } });
  const prompt = manager.prompt(provider);
  const { child, opts } = children[0];
  atomic(path.join(opts.env.CODEX_HOME, 'auth.json'), { tokens: { access_token: 'new', id_token: jwt('different'), account_id: 'same' } });
  child.emit('close', 0);
  assert.match(await prompt, /preserved/);
  assert.equal(accountAuth(provider).tokens.access_token, 'old');
});
