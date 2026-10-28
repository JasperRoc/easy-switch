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
