import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { selectRelease, compareVersions, downloadVerified, downloadPackage, validateArchiveEntries, DesktopUpdater, startWindowsUpdate } from '../desktop/updater.js';
import helper from '../desktop/update-helper.cjs';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const release = (version, suffix='mac-arm64.zip') => ({tag_name:`v${version}`,body:'Release notes',assets:[{name:`easy-switch-${version}-${suffix}`,browser_download_url:`https://github.com/JasperRoc/easy-switch/releases/download/v${version}/easy-switch-${version}-${suffix}`,size:3,digest:`sha256:${digest('abc')}`}]});
function temporary(t) {const directory=fs.mkdtempSync(path.join(os.tmpdir(),'switch-update-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
test('updates select a newer complete package for the current architecture, including project previews',()=>{
 assert.equal(compareVersions('0.10.0','0.9.0'),1); assert.equal(compareVersions('1.0.0','1.0.0-beta.2'),1);
 assert.equal(selectRelease([release('1.0.0'),{...release('2.0.0'),draft:true}], '0.4.0','darwin','arm64').version,'1.0.0');
 assert.equal(selectRelease([release('0.4.0')],'0.4.0','darwin','arm64'),null);
 assert.equal(selectRelease([release('1.0.0')],'0.4.0','win32','x64'),null);
 const invalid=release('1.0.0');invalid.assets[0].browser_download_url='https://evil.test/payload.zip';assert.throws(()=>selectRelease([invalid],'0.4.0','darwin','arm64'),/metadata/);
 const unsigned=release('1.0.0');delete unsigned.assets[0].digest;assert.throws(()=>selectRelease([unsigned],'0.4.0','darwin','arm64'),/metadata/);
});
test('a corrupt, truncated or oversized download never becomes an installable package',async t=>{
 const folder=temporary(t),dest=path.join(folder,'update.zip'),asset={size:3,sha256:digest('abc')};
 for(const value of ['abd','ab','abcd']) {await assert.rejects(downloadVerified(new Response(value),dest,asset));assert.equal(fs.existsSync(dest),false);assert.equal(fs.existsSync(dest+'.part'),false);}
 await downloadVerified(new Response('abc'),dest,asset);assert.equal(fs.readFileSync(dest,'utf8'),'abc');
 assert.throws(()=>validateArchiveEntries('easy-switch.app/a\n../outside'),/Unsafe/);assert.throws(()=>validateArchiveEntries('/outside'),/Unsafe/);
});
test('checking updates exposes release notes and performs no download or installation',async t=>{
 const urls=[],updater=new DesktopUpdater({root:temporary(t),current:'0.4.0',platform:'darwin',arch:'arm64',fetchImpl:async url=>{urls.push(url);return Response.json([release('0.5.0')]);}});
 await updater.check();assert.equal(updater.snapshot().phase,'available');assert.equal(updater.snapshot().notes,'Release notes');assert.equal(urls.length,1);assert.equal(updater.staged,null);
});
test('Windows waits for a verified helper handshake outside the installation directory and quotes paths safely', async t => {
 const directory=path.join(temporary(t), "用户's updates");fs.mkdirSync(directory);
 const receipt=path.join(directory,'pending.json'),job={current:'C:\\Program Files\\easy-switch\\easy-switch.exe',staged:path.join(directory,'update.exe'),receipt,version:'1.0.0',token:'fixture-token',parent:42,sha256:digest('abc'),size:3};
 let child;
 await startWindowsUpdate(job,(file,args,options)=>{
  assert.match(file,/WindowsPowerShell\\v1\.0\\powershell\.exe$/);assert.equal(options.cwd,directory);assert.equal(options.windowsHide,true);
  assert.equal(options.detached,true);assert.equal(options.stdio,'ignore');
  const command=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.match(command,/用户''s updates/);assert.match(command,/ -JobFile /);
  const descriptor=JSON.parse(fs.readFileSync(path.join(directory,'install.json')));assert.equal(descriptor.current,job.current);
  assert.equal(descriptor.sha256,job.sha256);assert.equal(fs.existsSync(path.join(directory,'windows-update.ps1')),true);
  child=new EventEmitter();child.unref=()=>{child.unreferenced=true;};child.kill=()=>{child.killed=true;};
  setTimeout(()=>fs.writeFileSync(descriptor.handshake,JSON.stringify({token:job.token,ready:true})),20);
  return child;
 });
 assert.equal(child.unreferenced,true);assert.equal(child.killed,undefined);
});
test('Windows rejects a helper that exits or fails verification instead of treating spawn as installation success', async t => {
 const directory=temporary(t),job={current:'C:\\easy-switch\\easy-switch.exe',staged:'fixture.exe',receipt:path.join(directory,'pending.json'),version:'1.0.0',token:'fixture-token'};
 for(const kind of ['exit','error','verification']) {
  let child;
  await assert.rejects(startWindowsUpdate(job,()=>{
   child=new EventEmitter();child.unref=()=>{};child.kill=()=>{child.killed=true;};
   setTimeout(()=>kind==='verification'?fs.writeFileSync(path.join(directory,'helper-ready.json'),JSON.stringify({token:job.token,error:'Update package SHA-256 verification failed.'})):child.emit(kind,kind==='exit'?1:Error('blocked')),10);
   return child;
  }),kind==='verification'?/SHA-256/:/helper could not start/);
  assert.equal(child.killed,true);
 }
});
test('startup confirms only the requested version and executable, retaining the receipt token', t => {
 const updater=new DesktopUpdater({root:temporary(t),current:'1.0.0'});
 const pending={version:'1.0.0',token:'fixture-token',ready:false,executable:process.execPath};
 for(const change of [{version:'0.9.0'},{executable:process.execPath+'.old'},{}]) {
  fs.writeFileSync(updater.receipt,JSON.stringify({...pending,...change}));updater.confirmLaunch();
  const value=JSON.parse(fs.readFileSync(updater.receipt));assert.equal(value.ready,Object.keys(change).length===0);assert.equal(value.token,pending.token);
 }
 updater.platform='win32';fs.writeFileSync(updater.receipt,JSON.stringify({...pending,executable:process.execPath.toUpperCase()}));updater.confirmLaunch();
 assert.equal(JSON.parse(fs.readFileSync(updater.receipt)).ready,true,'Windows executable paths ignore case');
});
test('a Windows installer failure remains visible on first check without losing the recovery installer', async t => {
 const root=temporary(t),directory=path.join(root,'updates');fs.mkdirSync(directory);
 const installer=path.join(directory,'update.exe');fs.writeFileSync(installer,'verified fixture');
 fs.writeFileSync(path.join(directory,'last-error.txt'),'The Windows installer failed (exit code 2). Run the downloaded installer manually.');
 let requests=0;
 const updater=new DesktopUpdater({root,current:'0.5.5',platform:'win32',arch:'x64',fetchImpl:async()=>{requests++;return Response.json([]);}});
 assert.equal(updater.snapshot().phase,'error');assert.match(updater.snapshot().error,/exit code 2/);assert.equal(fs.existsSync(installer),true);
 assert.equal((await updater.check()).phase,'error');assert.equal(requests,0);
 assert.equal((await updater.check()).phase,'current');assert.equal(requests,1);
});
test('replacement verifies before changing the app and rolls back on failed startup',async t=>{
 const folder=temporary(t),current=path.join(folder,'easy-switch.app'),staged=path.join(folder,'stage.app');
 fs.mkdirSync(current);fs.mkdirSync(staged);fs.writeFileSync(path.join(current,'version'),'old');fs.writeFileSync(path.join(staged,'version'),'new');
 const launches=[];await assert.rejects(helper.replaceApplication({current,staged,verify:()=>{},launch:app=>{launches.push(fs.readFileSync(path.join(app,'version'),'utf8'));return {exitCode:0};},accepted:async()=>false}),/confirm startup/);
 assert.equal(fs.readFileSync(path.join(current,'version'),'utf8'),'old');assert.deepEqual(launches,['new','old']);
 await assert.rejects(helper.replaceApplication({current,staged,verify:()=>{throw Error('Invalid signature');},launch:()=>{throw Error('must not launch');}}),/signature/);
 assert.equal(fs.readFileSync(path.join(current,'version'),'utf8'),'old');
 await helper.replaceApplication({current,staged,verify:()=>{},launch:()=>({}),accepted:async()=>true});assert.equal(fs.readFileSync(path.join(current,'version'),'utf8'),'new');
});

test('automatic updates use the system network transport and a failed download can be retried', async t => {
 const root=temporary(t); let attempts=0;
 const updater=new DesktopUpdater({root,current:'0.4.0',platform:'win32',arch:'x64',systemFetch:async url=>{
  if(url.includes('api.github.com'))return Response.json([release('0.5.0','win-x64.exe')]);
  if(++attempts===1)throw new TypeError('fetch failed: secret proxy information');
  return new Response('abc');
 }});
 await updater.check(); assert.equal(updater.snapshot().phase,'available');
 await assert.rejects(updater.download(),/connection or system proxy/);
 assert.equal(updater.snapshot().retryDownload,true); assert.equal(updater.snapshot().error.includes('secret'),false);
 assert.equal(fs.existsSync(path.join(root,'updates','easy-switch-0.5.0-win-x64.exe.part')),false);
 await updater.download();assert.equal(updater.snapshot().phase,'ready');assert.equal(updater.snapshot().retryDownload,false);
 assert.equal(fs.readFileSync(updater.staged,'utf8'),'abc');
});

test('large downloads use bounded parallel ranges, verify the whole file and resume only complete parts', async t => {
 const folder=temporary(t),destination=path.join(folder,'update.exe'),data=Buffer.alloc(16*1024*1024,17);
 const asset={url:'https://github.com/asset',size:data.length,sha256:digest(data)};
 let calls=[],active=0,peak=0,fail=true;
 const fetch=async(_url,options)=>{
  const [,from,to]=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);const start=Number(from),end=Number(to);
  calls.push(start);active++;peak=Math.max(peak,active);
  return new Response(new ReadableStream({async start(controller){
   await new Promise(resolve=>setTimeout(resolve,start===0?1:15));active--;
   if(fail&&start===data.length/2){controller.error(new TypeError('network interrupted'));return;}
   controller.enqueue(data.subarray(start,end+1));controller.close();
  }}),{status:206,headers:{'content-range':`bytes ${start}-${end}/${data.length}`}});
 };
 await assert.rejects(downloadPackage(fetch,asset,destination));
 assert.equal(fs.existsSync(destination),false);assert.ok(peak>1);
 const receipt=JSON.parse(fs.readFileSync(destination+'.parts.json'));
 assert.ok(receipt.completed.includes(0));
 calls=[];fail=false;
 await downloadPackage(fetch,asset,destination);
 assert.ok(!calls.includes(0),'verified complete parts are reused after a network interruption');
 assert.equal(digest(fs.readFileSync(destination)),asset.sha256);
 assert.equal(fs.existsSync(destination+'.parts.json'),false);
});

test('range-ignorant servers fall back to one verified stream and corrupt ranged data is discarded',async t=>{
 const folder=temporary(t),destination=path.join(folder,'update.exe'),data=Buffer.alloc(16*1024*1024,3);
 const asset={url:'https://github.com/asset',size:data.length,sha256:digest(data)};let calls=0;
 await downloadPackage(async()=>{calls++;return new Response(data);},asset,destination);
 assert.equal(calls,1);assert.equal(digest(fs.readFileSync(destination)),asset.sha256);
 fs.rmSync(destination);
 await assert.rejects(downloadPackage(async(_url,options)=>{
  const[,from,to]=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range),start=Number(from),end=Number(to);
  return new Response(Buffer.alloc(end-start+1,4),{status:206,headers:{'content-range':`bytes ${start}-${end}/${data.length}`}});
 },asset,destination),/SHA-256/);
 assert.equal(fs.existsSync(destination),false);assert.equal(fs.existsSync(destination+'.part'),false);
});
