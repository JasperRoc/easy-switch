import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { DesktopRuntime } from '../desktop/runtime.js';
import { restoreSession, restoredText } from '../desktop/config.js';
import { parse } from 'smol-toml';

async function setup(t, original = '# original\nmodel_provider="openai"\nmodel="original"\n') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-desktop-'));
  const root = path.join(directory, 'switch'), codexHome = path.join(directory, 'codex');
  fs.mkdirSync(codexHome); fs.writeFileSync(path.join(codexHome, 'config.toml'), original);
  const runtime = new DesktopRuntime({ root, codexHome, port: 0 });
  t.after(async () => { await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, codexHome, runtime, file: path.join(codexHome, 'config.toml'), original };
}
test('desktop routing exists only while the app runs; restart does not replace the original backup', async t => {
  const { runtime, file, original } = await setup(t);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await runtime.start();
  assert.equal(parse(fs.readFileSync(file, 'utf8')).model_provider, 'easy_switch');
  const record = fs.readFileSync(runtime.recordFile, 'utf8');
  await runtime.restartNetwork();
  assert.equal(fs.readFileSync(runtime.recordFile, 'utf8'), record);
  await runtime.stop();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(runtime.recordFile), false);
});
test('desktop preserves native subscription tools and leaves native auth untouched', async t => {
  const { runtime, codexHome, file, original } = await setup(t);
  const authFile = path.join(codexHome, 'auth.json'), auth = '{"tokens":{"access_token":"native-fixture","account_id":"account-fixture"}}\n';
  fs.writeFileSync(authFile, auth);
  await runtime.start();
  const provider = parse(fs.readFileSync(file, 'utf8')).model_providers.easy_switch;
  assert.equal(provider.requires_openai_auth, true);
  assert.equal(provider.http_headers['X-Easy-Switch-Token'], JSON.parse(fs.readFileSync(path.join(runtime.root, 'state.json'))).token);
  await runtime.stop();
  assert.equal(fs.readFileSync(authFile, 'utf8'), auth); assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('desktop exit preserves model changes and unrelated configuration text', async t => {
  const { runtime, file } = await setup(t);
  await runtime.start();
  const active = fs.readFileSync(file, 'utf8').replace('model="original"', 'model="new"') + '\n# user addition\n[mcp_servers.example]\ncommand="example"\n';
  fs.writeFileSync(file, active);
  await runtime.stop();
  const restored = fs.readFileSync(file, 'utf8');
  assert.match(restored, /# user addition/);
  assert.equal(parse(restored).model, 'new');
  assert.equal(parse(restored).model_provider, 'openai');
  assert.equal(parse(restored).model_providers?.easy_switch, undefined);
  assert.equal(parse(restored).mcp_servers.example.command, 'example');
});
test('modified managed provider is never silently overwritten', async t => {
  const { runtime, file } = await setup(t);
  await runtime.start();
  const active = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, active.replace('Bearer ', 'Changed '));
  await assert.rejects(runtime.stop(), /provider was edited/);
  assert.ok(runtime.server);
  assert.ok(fs.existsSync(runtime.recordFile));
  fs.writeFileSync(file, active);
});
test('unusual TOML cannot be corrupted by desktop restoration', async t => {
  const { runtime, file } = await setup(t, 'note="""\n[model_providers.fake]\nx=1\n"""\nmodel="original"\n');
  await runtime.start();
  const record = JSON.parse(fs.readFileSync(runtime.recordFile));
  const changed = fs.readFileSync(file, 'utf8').replace('model="original"', 'model="changed"');
  const restored = restoredText(changed, record);
  assert.equal(parse(restored).note, parse(record.original).note);
  assert.equal(parse(restored).model, 'changed');
});
test('independent guard restores configuration if the desktop process crashes', { timeout: 15000 }, async t => {
  const { directory, root, codexHome, runtime, file, original } = await setup(t);
  const script = `import {DesktopRuntime} from ${JSON.stringify(new URL('../desktop/runtime.js', import.meta.url).href)}; const runtime=new DesktopRuntime({root:${JSON.stringify(root)},codexHome:${JSON.stringify(codexHome)},port:0});await runtime.start();console.log('READY');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const ready = new Promise(resolve => readline.createInterface({ input: child.stdout }).on('line', line => { if (line === 'READY') resolve(); }));
  child.stderr.resume(); await ready;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  for (let n = 0; n < 50 && fs.existsSync(runtime.recordFile); n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(runtime.recordFile), false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('rapid start and stop requests cannot leave configuration pointing to a stopped proxy', async t => {
  const { runtime, file, original } = await setup(t);
  await Promise.all([runtime.start(), runtime.stop(), runtime.start(), runtime.restartNetwork(), runtime.stop()]);
  assert.equal(runtime.server, null);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('desktop restores the absence of configuration on a fresh installation', async t => {
  const { runtime, file } = await setup(t);
  fs.rmSync(file);
  await runtime.start(); await runtime.stop();
  assert.equal(fs.existsSync(file), false);
});
test('an occupied port does not change Codex configuration', async t => {
  const first = await setup(t), second = await setup(t);
  await first.runtime.start(); second.runtime.port = first.runtime.port;
  await assert.rejects(second.runtime.start(), { code:'EADDRINUSE' });
  assert.equal(fs.readFileSync(second.file, 'utf8'), second.original);
  assert.equal(fs.existsSync(second.runtime.recordFile), false);
});
