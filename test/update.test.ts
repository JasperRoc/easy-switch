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
test('update invokes the current-user installer with its recorded environment and cleans temporary source', t => {
  const { root, codexHome } = fixture(t);
  const calls = [];
  updateTool(root, (binary, args, options) => {
    calls.push({ binary, args, options });
  });
  assert.deepEqual(calls[0].args.slice(0, 6), ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/JasperRoc/fluid.git']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].binary, 'sh');
  assert.equal(calls[1].args[0], path.join(calls[0].args.at(-1), 'install.sh'));
  assert.equal(calls[1].options.env.CODEX_HOME, codexHome);
  assert.equal(calls[1].options.env.SWITCH_HOME, root);
  assert.equal(calls[1].options.env.SWITCH_PORT, '19999');
  assert.ok(calls[1].options.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter));
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
  const file = path.join(codexHome, 'config.toml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('127.0.0.1:19999', '127.0.0.1:18888'));
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
    });
  } finally {
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
  }
});


test('update permits model preference changes without rewriting the configuration', t => {
  const { root, codexHome } = fixture(t);
  const file = path.join(codexHome, 'config.toml');
  const changed = 'model="gpt-6.1-sol"\nmodel_reasoning_effort="low"\n' + fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, changed);
  let calls = 0;
  updateTool(root, (_binary, args) => {
    calls++;
  });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
});
