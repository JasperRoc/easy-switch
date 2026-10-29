import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopController } from '../desktop/controller.js';
import { readState, addProvider, atomic } from '../src/store.js';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-desktop-controller-'));
  t.after(() => fs.rmSync(directory, { recursive:true,force:true }));
  return new DesktopController({ root:path.join(directory,'switch'),codexHome:path.join(directory,'codex'),binary:'not-used',port:0 });
}
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
test('desktop model selection validates effort and rejects a stale provider catalog', t => {
  const controller = setup(t);
  controller.addAPI({alias:'first',key:'fixture-first'}); controller.addAPI({alias:'second',key:'fixture-second'});
  controller.catalog={alias:'first',models:[{id:'fixture-model',efforts:['low','high']}]};
  controller.model({model:'fixture-model',effort:'high'});
  assert.deepEqual(controller.snapshot().model,{model:'fixture-model',effort:'high'});
  assert.throws(()=>controller.model({model:'fixture-model',effort:'unsupported'}),/supported effort/);
  controller.switchProvider('second');
  assert.throws(()=>controller.model({model:'fixture-model',effort:'high'}),/Reload/);
  controller.model(null); assert.equal(controller.snapshot().model,null);
});
test('desktop appearance preferences persist and invalid choices never replace them', t => {
  const controller = setup(t);
  controller.setPreferences({language:'zh-CN',theme:'dark'});
  assert.deepEqual(controller.preferences(),{language:'zh-CN',theme:'dark'});
  for (const patch of [{language:'unknown'}, {theme:'unknown'}, {extra:'unrequested'}, {startAtLogin:'yes'}]) assert.throws(()=>controller.setPreferences(patch), /Invalid/);
  assert.deepEqual(controller.preferences(),{language:'zh-CN',theme:'dark'});
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
test('desktop network reports the actual routing port separately and applies detected settings', async t => {
  const controller = setup(t);
  controller.originalEnv = {};
  controller.detectProxy = async () => ({ httpsProxy: 'http://127.0.0.1:7890', source: 'macOS' });
  const before = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); });
  await controller.configureNetwork(); controller.runtime.port = 23456;
  assert.equal(controller.network().httpsProxy, 'http://127.0.0.1:7890');
  assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(controller.network().localProxy.url, 'http://127.0.0.1:23456/v1');
  await controller.saveNetwork({ proxy: '' });
  assert.equal(controller.network().httpsProxy, ''); assert.equal(process.env.HTTPS_PROXY, '');
});
