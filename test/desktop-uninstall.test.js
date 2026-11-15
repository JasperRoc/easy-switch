import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeDesktopData } from '../desktop/uninstall.js';
import { DesktopRuntime } from '../desktop/runtime.js';
import { atomic, init, addProvider } from '../src/store.js';

test('complete cleanup restores external client settings, removes isolated logins and leaves original conversations untouched', async t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'switch-uninstall-')),root=path.join(home,'switch'),codexHome=path.join(home,'codex');
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(codexHome);const original='model="my-model"\n';fs.writeFileSync(path.join(codexHome,'config.toml'),original);
 fs.writeFileSync(path.join(codexHome,'conversation.jsonl'),'user-data');
 const account=path.join(root,'claude','accounts','saved');atomic(path.join(account,'oauth.json'),{accessToken:'private'});
 const runtime=new DesktopRuntime({root,codexHome,port:0});await runtime.start();
 await runtime.stop();await runtime.start();
 const loginCopies=[];
 await removeDesktopData(root,{home,removeLogin:async directory=>loginCopies.push(directory)});
 assert.equal(fs.existsSync(root),false);assert.deepEqual(loginCopies,[account]);
 assert.equal(fs.readFileSync(path.join(codexHome,'config.toml'),'utf8'),original);
 assert.equal(fs.readFileSync(path.join(codexHome,'conversation.jsonl'),'utf8'),'user-data');
 await runtime.stop();
});

test('cleanup retains its recovery data on a conflicting config and rejects unsafe roots',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'switch-uninstall-conflict-')),root=path.join(home,'switch'),codexHome=path.join(home,'codex');
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(codexHome);
 const runtime=new DesktopRuntime({root,codexHome,port:0});await runtime.start();
 t.after(async()=>{try{await runtime.stop();}catch{}runtime.server?.closeAllConnections();runtime.server?.close();runtime.guard?.kill();});
 const file=path.join(codexHome,'config.toml'),original=fs.readFileSync(file,'utf8');
 fs.writeFileSync(file,original.replace('name = "easy-switch"','name = "user-edit"'));
 await assert.rejects(removeDesktopData(root,{home}),/edited/);assert.ok(fs.existsSync(path.join(root,'desktop-session.json')));
 fs.writeFileSync(file,original);await runtime.stop();
 await assert.rejects(removeDesktopData(home,{home}),/unsafe/);
 if(process.platform!=='win32'){const linked=path.join(home,'linked');fs.symlinkSync(root,linked);await assert.rejects(removeDesktopData(linked,{home}),/unsafe/);}
});

test('headless cleanup works from an installed application without opening a window or reading personal paths',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'switch-uninstall-worker-')),root=path.join(directory,'data');
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));init(root);atomic(path.join(root,'desktop.json'),{language:'en'});
 const script=new URL('../desktop/uninstall-cli.cjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[script,'--root',root],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const [code]=await once(child,'exit');assert.equal(code,0,stderr);assert.equal(fs.existsSync(root),false);
});
