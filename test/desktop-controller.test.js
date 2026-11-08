import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { DesktopController } from '../desktop/controller.js';
import { readState, addProvider, atomic } from '../src/store.js';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-desktop-controller-'));
  t.after(() => fs.rmSync(directory, { recursive:true,force:true }));
  return new DesktopController({ root:path.join(directory,'switch'),codexHome:path.join(directory,'codex'),binary:'not-used',port:0 });
}
test('tray-only snapshots never query quota or retain removed session metadata tracking', t => {
  const controller = setup(t); controller.runtime.active = true;
  controller.usage.snapshot = () => assert.fail('quota read in tray-only snapshot');
  assert.equal(controller.runtime.sessions, undefined);
  assert.equal(controller.snapshot({ usage: false }).sessions, undefined);
});
test('desktop API setup defaults to official URL, persists order and exports no credentials', t => {
  const controller = setup(t);
  assert.equal(fs.existsSync(path.join(controller.codexHome,'config.toml')),false);
  controller.addAPI({alias:'official',key:'fixture-official'});
  controller.addAPI({alias:'relay',url:'https://example.test/v1/',key:'fixture-relay'});
  controller.order(['relay','official']); controller.switchProvider('relay');
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.providers.map(p=>p.alias),['relay','official']);
  assert.equal(snapshot.active,'relay');
  assert.equal(readState(controller.root).providers.official.baseUrl,'https://api.openai.com/v1');
  assert.equal(JSON.stringify(snapshot).includes('fixture-'),false);
  assert.equal(JSON.stringify(snapshot).includes(readState(controller.root).token),false);
  assert.throws(()=>controller.addAPI({alias:'bad',key:''}),/API key/);
});
test('provider model lookup uses the requested inactive row and rejects results after an edit or removal', async t => {
  const controller = setup(t), calls = []; let release, received;
  const server = http.createServer(async (req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    if (received) { const ready = received; received = null; await new Promise(resolve => { release = resolve; ready(); }); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'relay-only' }] }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  controller.addAPI({ alias: 'active', key: 'active-secret' });
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  controller.addAPI({ alias: 'inactive', url, key: 'inactive-secret' });
  const result = await controller.models('inactive');
  assert.equal(result.alias, 'inactive'); assert.equal(result.client, 'codex');
  assert.deepEqual(result.models.map(model => model.id), ['relay-only']);
  assert.equal(readState(controller.root).active, 'active');
  assert.deepEqual(calls, [{ url: '/v1/models', authorization: 'Bearer inactive-secret' }]);
  assert.equal(JSON.stringify(result).includes('inactive-secret'), false);
  for (const mutation of ['edit', 'remove']) {
    const ready = new Promise(resolve => { received = resolve; });
    const pending = controller.models('inactive'); await ready;
    if (mutation === 'edit') controller.edit({ original: 'inactive', alias: 'inactive', key: 'new-secret' });
    else controller.remove('inactive');
    release(); await assert.rejects(pending, /provider changed while loading/);
  }
  await assert.rejects(controller.models('inactive'), /Unknown provider/);
});
test('desktop appearance preferences persist and invalid choices never replace them', t => {
  const controller = setup(t);
  controller.setPreferences({language:'zh-CN',theme:'dark'});
  assert.deepEqual(controller.preferences(),{language:'zh-CN',theme:'dark'});
  for (const patch of [{language:'unknown'}, {theme:'unknown'}, {extra:'unrequested'}, {startAtLogin:'yes'}]) assert.throws(()=>controller.setPreferences(patch), /Invalid/);
  assert.deepEqual(controller.preferences(),{language:'zh-CN',theme:'dark'});
});
test('unreadable desktop preferences do not prevent routing or overwrite the original settings', async t => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const controller = setup(t);
    controller.addAPI({ alias: 'saved', key: 'fixture-key' });
    controller.setPreferences({ language: 'zh-CN', theme: 'dark' });
    const original = fs.readFileSync(controller.preferencesFile, 'utf8');
    const providers = fs.readFileSync(path.join(controller.root, 'state.json'), 'utf8');
    const reopened = new DesktopController({ root: controller.root, codexHome: controller.codexHome, binary: 'not-used', port: 0 });
    const read = fs.readFileSync;
    let blocked = true;
    const mock = t.mock.method(fs, 'readFileSync', function(file, ...args) {
      if (file === controller.preferencesFile && blocked) throw Object.assign(new Error('Access denied'), { code });
      return read.call(this, file, ...args);
    });
    t.after(() => reopened.stop());
    assert.deepEqual(reopened.preferences(), {});
    await reopened.start();
    assert.equal(reopened.snapshot().running, true);
    assert.equal(reopened.snapshot().preferencesError, code);
    assert.equal(reopened.snapshot().providers[0].alias, 'saved');
    assert.throws(() => reopened.setPreferences({ theme: 'light' }), /Restore access to desktop.json/);
    assert.equal(read(controller.preferencesFile, 'utf8'), original);
    assert.equal(read(path.join(controller.root, 'state.json'), 'utf8'), providers);
    blocked = false;
    assert.deepEqual(reopened.preferences(), { language: 'zh-CN', theme: 'dark' });
    assert.equal(reopened.snapshot().preferencesError, null);
    reopened.setPreferences({ theme: 'light' });
    assert.deepEqual(reopened.preferences(), { language: 'zh-CN', theme: 'light' });
    await reopened.stop(); mock.mock.restore();
  }
});
test('a later preference read failure keeps the current client and appearance until access recovers', t => {
  const controller = setup(t);
  controller.setPreferences({ client: 'claude', language: 'zh-CN', theme: 'dark' });
  const previous = controller.preferences(), read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === controller.preferencesFile) throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
    return read.call(this, file, ...args);
  });
  assert.deepEqual(controller.preferences(), previous);
  assert.equal(controller.snapshot().client, 'claude');
  assert.equal(controller.snapshot().preferencesError, 'EPERM');
});
test('desktop preferences retry once after a narrow access repair without changing file contents', t => {
  const controller = setup(t);
  controller.setPreferences({ language: 'zh-CN', theme: 'dark' });
  const original = fs.readFileSync(controller.preferencesFile, 'utf8'), read = fs.readFileSync;
  let blocked = true, attempts = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === controller.preferencesFile && blocked) throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
    return read.call(this, file, ...args);
  });
  controller.repairPreferences = file => { attempts++; assert.equal(file, controller.preferencesFile); blocked = false; return 'repaired'; };
  assert.deepEqual(controller.preferences(), { language: 'zh-CN', theme: 'dark' });
  assert.equal(attempts, 1); assert.equal(controller.preferencesError, null);
  assert.equal(read(controller.preferencesFile, 'utf8'), original);
  blocked = true; controller.preferences(); controller.preferences(); assert.equal(attempts, 1);
  assert.equal(controller.preferencesError, 'EPERM');
});
test('deleting providers removes their secret and selects the next alias', t => {
 const controller=setup(t);
 controller.addAPI({alias:'first',key:'fixture-first'});controller.addAPI({alias:'second',key:'fixture-second'});
 controller.remove('first');assert.equal(controller.snapshot().active,'second');assert.equal(fs.readFileSync(path.join(controller.root,'state.json'),'utf8').includes('fixture-first'),false);
 controller.remove('second');assert.equal(controller.snapshot().active,null);assert.deepEqual(controller.snapshot().providers,[]);
});

test('account deletion removes owned credential copies while retaining external Codex credentials',t=>{
 const controller=setup(t),owned=path.join(controller.root,'accounts','owned'),external=controller.codexHome;
 atomic(path.join(owned,'auth.json'),{tokens:{access_token:'fixture',account_id:'fixture'}});
 atomic(path.join(external,'auth.json'),{tokens:{access_token:'fixture',account_id:'fixture'}});
 addProvider('owned',{type:'account',accountHome:owned},controller.root);addProvider('external',{type:'account',accountHome:external},controller.root);
 controller.remove('owned');assert.equal(fs.existsSync(owned),false);
 controller.remove('external');assert.equal(fs.existsSync(path.join(external,'auth.json')),true);
});

test('device codes are cleared on completion, including completion before ready resolves', async t => {
  for (const early of [false, true]) {
    const controller = setup(t);
    let ready, complete;
    controller.reauth = { start: () => ({ ready: new Promise(resolve => { ready = resolve; }), completed: new Promise(resolve => { complete = resolve; }) }) };
    const pending = controller.startLogin('subscription');
    const message = 'Open https://auth.openai.com/codex/device code TEST-1234';
    if (early) complete({ success: true, message: 'Authentication complete. Retry your request.' });
    ready(message); await pending;
    if (!early) {
      assert.equal(controller.snapshot().login.code, 'TEST-1234');
      complete({ success: true, message: 'Authentication complete. Retry your request.' }); await Promise.resolve();
    }
    const login = controller.snapshot().login;
    assert.equal(login.phase, 'complete'); assert.equal(login.code, undefined); assert.equal(login.url, undefined);
    assert.equal(JSON.stringify(login).includes('TEST-1234'), false);
  }
});
test('failed authentication clears the verification code and permits retry', async t => {
  const controller = setup(t); let complete;
  controller.reauth = { start: () => ({ ready: Promise.resolve('https://auth.openai.com/codex/device TEST-1234'), completed: new Promise(resolve => { complete = resolve; }) }) };
  await controller.startLogin('subscription'); complete({ success: false, message: 'Authentication cancelled.' }); await Promise.resolve();
  assert.equal(controller.snapshot().login.phase, 'failed'); assert.equal(controller.snapshot().login.code, undefined);
  await controller.startLogin('subscription'); assert.equal(controller.snapshot().login.phase, 'pending');
});
test('desktop automatically applies detected system proxies and honors an explicit direct environment', async t => {
  const controller = setup(t);
  controller.originalEnv = {};
  controller.detectProxy = async () => ({ httpsProxy: 'http://127.0.0.1:7890', source: 'macOS' });
  const before = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
  await controller.configureNetwork();
  assert.equal(controller.network().httpsProxy, 'http://127.0.0.1:7890');
  assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(controller.network().source, 'macOS');
  assert.equal(fs.existsSync(path.join(controller.root, 'network.json')), false);
  controller.originalEnv = { HTTP_PROXY: '', HTTPS_PROXY: '' };
  await controller.configureNetwork();
  assert.equal(controller.network().httpsProxy, ''); assert.equal(process.env.HTTPS_PROXY, '');
});
