import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { selectRelease, compareVersions, downloadVerified, validateArchiveEntries, DesktopUpdater } from '../desktop/updater.js';
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
 await assert.rejects(updater.download(),/Connection settings/);
 assert.equal(updater.snapshot().retryDownload,true); assert.equal(updater.snapshot().error.includes('secret'),false);
 assert.equal(fs.existsSync(path.join(root,'updates','easy-switch-0.5.0-win-x64.exe.part')),false);
 await updater.download();assert.equal(updater.snapshot().phase,'ready');assert.equal(updater.snapshot().retryDownload,false);
 assert.equal(fs.readFileSync(updater.staged,'utf8'),'abc');
});
