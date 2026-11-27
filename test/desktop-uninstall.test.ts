import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 t.after(async()=>{try{await runtime.stop();}catch{}});
 const file=path.join(codexHome,'config.toml'),original=fs.readFileSync(file,'utf8');
 fs.writeFileSync(file,original.replace('name = "fluid"','name = "user-edit"'));
 await assert.rejects(removeDesktopData(root,{home}),/edited/);assert.ok(fs.existsSync(path.join(root,'desktop-session.json')));
 fs.writeFileSync(file,original);await runtime.stop();
 await assert.rejects(removeDesktopData(home,{home}),/unsafe/);
 if(process.platform!=='win32'){const linked=path.join(home,'linked');fs.symlinkSync(root,linked);await assert.rejects(removeDesktopData(linked,{home}),/unsafe/);}
});

test('headless cleanup works from the feature worker without opening a window', { timeout: 10000 }, async t => {
 const { spawn } = await import('node:child_process'), { once } = await import('node:events');
 const readline = await import('node:readline');
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-uninstall-worker-')), root = path.join(directory, 'data');
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 init(root); atomic(path.join(root, 'desktop.json'), { language: 'en' });
 const child = spawn(process.execPath, [fileURLToPath(new URL('../desktop/worker.js', import.meta.url))],
   { env: { ...process.env, SWITCH_HOME: root, CODEX_HOME: path.join(directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude') },
     stdio: ['pipe', 'pipe', 'inherit'] });
 const exited = once(child, 'exit');
 t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
 const replies = readline.createInterface({ input: child.stdout });
 const answer = once(replies, 'line');
 child.stdin.write(JSON.stringify({ id: 1, action: 'uninstall-data' }) + '\n');
 assert.deepEqual(JSON.parse((await answer)[0]), { id: 1, value: null });
 child.stdin.end();
 assert.equal((await exited)[0], 0);
 assert.equal(fs.existsSync(root), false);
});
