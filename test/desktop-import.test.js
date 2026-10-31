import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopController } from '../desktop/controller.js';
import { readState, atomic } from '../src/store.js';

function setup(t, config = '', auth, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'switch'), codexHome = path.join(directory, 'codex');
  fs.mkdirSync(codexHome); fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
  if (auth) atomic(path.join(codexHome, 'auth.json'), auth);
  return new DesktopController({ root, codexHome, binary: 'not-used', env });
}
test('API import detects inline credentials without auth.json and never previews the key', t => {
  const controller = setup(t, 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.test/v1"\nexperimental_bearer_token="fixture-secret"\n');
  const preview = controller.existingLogin();
  assert.deepEqual(preview, { type: 'api', baseUrl: 'https://example.test/v1', alias: 'relay' });
  controller.importLogin(preview.alias);
  assert.equal(readState(controller.root).providers.relay.apiKey, 'fixture-secret');
  assert.equal(JSON.stringify(controller.snapshot()).includes('fixture-secret'), false);
  assert.equal(controller.existingLogin().alias, 'relay-2');
});
test('import resolves the pre-routing provider, environment keys and API auth files', t => {
  const original = 'model_provider="work"\n[model_providers.work]\nbase_url="https://example.test/v1"\nenv_key="WORK_API_KEY"\n';
  const controller = setup(t, original.replace('model_provider="work"', 'model_provider="easy_switch"'), undefined, { WORK_API_KEY: 'fixture-env' });
  atomic(controller.runtime.recordFile, { file: path.join(controller.codexHome, 'config.toml'), original });
  controller.importLogin('work'); assert.equal(readState(controller.root).providers.work.apiKey, 'fixture-env');
  const official = setup(t, '', { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-official' });
  official.importLogin('official'); assert.equal(readState(official.root).providers.official.baseUrl, 'https://api.openai.com/v1');
});
test('subscription import copies credentials; missing, unsupported and unavailable credentials have actionable errors', t => {
  const account = setup(t, '', { tokens: { access_token: 'fixture-account', account_id: 'fixture' } });
  assert.equal(account.existingLogin().type, 'account'); account.importLogin('account');
  assert.ok(fs.existsSync(path.join(account.root, 'accounts', 'account', 'auth.json')));
  const absent = setup(t); assert.throws(() => absent.importLogin('missing'), /No readable Codex credentials/);
  const missingEnv = setup(t, 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.test/v1"\nenv_key="MISSING"\n', { OPENAI_API_KEY: 'unrelated-secret' });
  assert.throws(() => missingEnv.importLogin('relay'), /environment variable/);
  const incompatible = setup(t, 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.test/v1"\nwire_api="chat"\nexperimental_bearer_token="fixture"\n');
  assert.throws(() => incompatible.importLogin('relay'), /unsupported protocol/);
  const unrelated = setup(t, 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://example.test/v1"\nrequires_openai_auth=false\n', { OPENAI_API_KEY: 'unrelated-secret' });
  assert.throws(() => unrelated.importLogin('relay'), /No readable Codex credentials/);
});
test('temporary native subscription setup does not hide the original API credentials from import', t => {
  const original = 'model_provider="openai"\n';
  const controller = setup(t, 'model_provider="easy_switch"\n', { auth_mode: 'chatgpt', tokens: { access_token: 'temporary-account', account_id: 'fixture' } });
  atomic(controller.runtime.recordFile, { file: path.join(controller.codexHome, 'config.toml'), original,
    auth: { file: path.join(controller.codexHome, 'auth.json'), original: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'original-api' }) } });
  assert.equal(controller.existingLogin().type, 'api'); controller.importLogin('original');
  assert.equal(readState(controller.root).providers.original.apiKey, 'original-api');
});
