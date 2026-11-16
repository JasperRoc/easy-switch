// A real Chromium page with a simulated ChatGPT UI; no account or paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const modern of [false, true]) test(`real isolated browser (${modern ? 'current contenteditable page' : 'legacy textarea page'}) returns native image output and quota errors without Codex authentication`, { skip: process.env.SWITCH_TEST_DESKTOP !== '1', timeout: 30000 }, async t => {
 const { _electron } = await import('playwright-core');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-web-image-browser-'));
 const app=await _electron.launch({args:[fileURLToPath(new URL('./fixtures/web-images.cjs',import.meta.url))],env:{...process.env,SWITCH_WEB_IMAGE_TEST_ROOT:root,SWITCH_WEB_IMAGE_MODERN:modern?'1':'0'},timeout:15000});
 app.process().stderr?.resume();
 t.after(async()=>{await app.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});});
 for(let index=0;index<100;index++){if(await app.evaluate(()=>!!globalThis.webImageFixture))break;await new Promise(resolve=>setTimeout(resolve,50));}
 const result=await app.evaluate(()=>globalThis.webImageFixture.run('image'));
 assert.equal(result.status,200,JSON.stringify(result));assert.ok(result.bytes>100);assert.equal(result.phase,'ready');
 const edited=await app.evaluate(()=>globalThis.webImageFixture.run('edit'));
 assert.equal(edited.status,200,JSON.stringify(edited));assert.ok(edited.bytes>100);
 const quota=await app.evaluate(()=>globalThis.webImageFixture.run('quota'));
 assert.equal(quota.status,429,JSON.stringify(quota));assert.equal(quota.phase,'attention');
 const prequota=await app.evaluate(()=>globalThis.webImageFixture.run('prequota'));
 assert.equal(prequota.status,429,JSON.stringify(prequota));assert.equal(prequota.phase,'attention');
 assert.equal(fs.existsSync(path.join(root,'auth.json')),false);assert.equal(fs.existsSync(path.join(root,'config.toml')),false);
});

test('isolated image sign-in cookies survive app restarts and are deleted only by explicit disconnect', { skip: process.env.SWITCH_TEST_DESKTOP !== '1', timeout: 30000 }, async t => {
 const executable=(await import('electron')).default;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-web-image-persistence-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const outcomes=[];
 for(const action of ['write','read','clear','read']){
  const env={...process.env,SWITCH_WEB_IMAGE_TEST_ROOT:root,SWITCH_WEB_IMAGE_PERSIST_ACTION:action};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,[fileURLToPath(new URL('./fixtures/web-images.cjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  const [code]=await once(child,'exit');assert.equal(code,0,errors);
  const result=output.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).at(-1);
  assert.equal(result.persistent,true);assert.equal(result.inside,true);outcomes.push(result.saved);
 }
 assert.deepEqual(outcomes,[true,true,false,false]);
 assert.equal(fs.existsSync(path.join(root,'auth.json')),false);
});
