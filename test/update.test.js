import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init } from '../src/store.js';
import { prepareConfig } from '../src/install.js';
import { updateTool } from '../src/update.js';
import { saveNetwork } from '../src/network.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  prepareConfig(root, codexHome, 19999, init(root).token).apply();
  return { root, codexHome };
}
test('update installs an archive, restores installation environment, and cleans temporary source', t => {
  const { root, codexHome } = fixture(t);
  const calls = [];
  updateTool(root, (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'pack') return '[{"filename":"easy-switch-0.1.0.tgz"}]';
    if (args[0] === 'root') return '/global/node_modules';
  });
  assert.deepEqual(calls[0].args.slice(0, 6), ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/JasperRoc/easy-switch.git']);
  assert.match(calls[3].args.at(-1), /easy-switch-0\.1\.0\.tgz$/);
  assert.equal(calls[5].options.env.CODEX_HOME, codexHome);
  assert.equal(calls[5].options.env.SWITCH_HOME, root);
  assert.equal(calls[5].options.env.SWITCH_PORT, '19999');
  assert.ok(!fs.existsSync(path.dirname(calls[0].args.at(-1))));
});
test('download failure stops before installation and removes temporary directory', t => {
  const { root } = fixture(t);
  let source, calls = 0;
  assert.throws(() => updateTool(root, (_binary, args) => {
    calls++; source = args.at(-1); throw Error('download failed');
  }), /download failed/);
  assert.equal(calls, 1);
  assert.ok(!fs.existsSync(path.dirname(source)));
});
test('configuration conflicts stop update before any command runs', t => {
  const { root, codexHome } = fixture(t);
  fs.appendFileSync(path.join(codexHome, 'config.toml'), '\n# user edit');
  let called = false;
  assert.throws(() => updateTool(root, () => { called = true; }));
  assert.equal(called, false);
});


test('update forwards stored proxy settings to git, npm, and service setup', t => {
  const { root } = fixture(t);
  saveNetwork(root, { HTTPS_PROXY: 'http://127.0.0.1:20000' });
  const names = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    updateTool(root, (_binary, args, options) => {
      assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:20000');
      assert.equal(options.env.https_proxy, 'http://127.0.0.1:20000');
      assert.ok(options.env.NO_PROXY.includes('127.0.0.1'));
      if (args[0] === 'pack') return '[{"filename":"easy-switch-test.tgz"}]';
      if (args[0] === 'root') return '/global/node_modules';
    });
  } finally {
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
  }
});
