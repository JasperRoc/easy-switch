import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageStats } from '../src/usage-stats.js';
import { officialTokenCost } from '../src/model-prices.js';
import { init, addProvider, editProvider, readState, activate, activateFallback, removeProvider } from '../src/store.js';

test('usage stats normalize distinct cache semantics, leave missing usage unknown and exclude subscription cost', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-stats-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); init(root);
  const now=Date.parse('2026-11-25T10:00:00Z'); const directory=path.join(root,'usage'); fs.mkdirSync(directory);
  const common={at:now,provider:'relay',model:'gpt-6.2-sol',status:200,outcome:'success',durationMs:1000};
  const entries=[{...common,client:'codex',input:100,output:10,cached:80},{...common,client:'claude',input:20,output:10,cached:80},{...common,client:'codex',input:100,output:10,cached:80,account:true},{...common,client:'codex',outcome:'failed',status:503}];
  fs.writeFileSync(path.join(directory,'2026-11-25.jsonl'),entries.map(v=>JSON.stringify(v)).join('\n')+'\n{partial');
  fs.writeFileSync(path.join(root,'usage-prices.json'), 'old-manual-prices-are-ignored');
  const data=await usageStats(root,{},now); assert.equal(data.summary.requests,4); assert.equal(data.summary.reported,3); assert.equal(data.summary.input,300); assert.equal(data.summary.cached,240); assert.equal(data.summary.priced,2); assert.ok(Math.abs(data.summary.cost-.000296)<1e-10);
  assert.equal(data.rows.filter(v=>v.total===null).length,1); assert.equal((await usageStats(root,{client:'claude',group:'models'},now)).rows[0].input,100);
  assert.equal((await usageStats(root,{days:1,offsetMinutes:-480},now)).daily[0].date,'2026-11-25');
});

test('disabled providers preserve configuration and order while selection and fallback cannot reactivate them', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-enabled-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const alias of ['a','b','c'])addProvider(alias,{type:'api',baseUrl:'https://example.test/v1',apiKey:'SECRET'},root);
 editProvider('b',{enabled:false},root);editProvider('a',{enabled:false},root);let state=readState(root);assert.equal(state.active,'c');assert.deepEqual(state.order,['a','b','c']);assert.equal(state.providers.a.apiKey,'SECRET');
 assert.throws(()=>activate('a',root),/Enable/);assert.equal(activateFallback('b',state.generation,'c',429,root),false);
 editProvider('c',{enabled:false},root);assert.equal(readState(root).active,null);editProvider('b',{enabled:true},root);assert.equal(readState(root).active,'b');removeProvider('b',root);assert.equal(readState(root).active,null);
});

test('usage pages remain newest-first with concurrent completion order, cache absence is unknown and prices never apply to images',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-stats-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));init(root);const directory=path.join(root,'usage');fs.mkdirSync(directory);const now=Date.now();
 const entries=Array.from({length:40},(_,index)=>({at:now-index*1000,client:'codex',provider:'relay',model:'gpt-6.2-sol',status:200,outcome:'success',durationMs:1000,input:100,output:10,image:index===0})).reverse();
 fs.writeFileSync(path.join(directory,new Date(now).toISOString().slice(0,10)+'.jsonl'),entries.map(row=>JSON.stringify(row)).join('\n'));
 const first=await usageStats(root,{},now);assert.equal(first.rows[0].at,now);assert.equal(first.rows[0].cost,null);assert.equal(first.summary.cacheReported,0);assert.equal(first.summary.priced,39);
 const second=await usageStats(root,{page:1},now);assert.equal(second.rows[0].at,now-25000);assert.equal(second.rows.length,15);
});

test('model summaries keep unnamed image requests separate from unnamed text requests and provider aliases retain their client', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-stats-models-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));init(root);
 const now=Date.now(),directory=path.join(root,'usage');fs.mkdirSync(directory);
 const row={schema:2,at:now,client:'codex',provider:'aos',model:'',account:false,status:200,outcome:'success',durationMs:100};
 fs.writeFileSync(path.join(directory,new Date(now).toISOString().slice(0,10)+'.jsonl'),[row,{...row,image:true},{...row,client:'claude',model:'deepseek-v4-pro'}].map(row=>JSON.stringify(row)).join('\n'));
 const models=await usageStats(root,{group:'models'},now);assert.equal(models.counts.models,3);assert.equal(models.rows.length,3);
 assert.equal(models.rows.find(row=>row.image).requests,1);assert.equal(models.rows.find(row=>row.model===''&&!row.image).requests,1);
 const providers=await usageStats(root,{group:'providers'},now);assert.equal(providers.rows.length,2);assert.deepEqual(providers.rows.map(row=>row.client).sort(),['claude','codex']);
});


test('official reference prices handle cache writes, long contexts and actual model identity across clients',()=>{
 const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
 close(officialTokenCost('gpt-6.2-sol',12000,1000,4000,7000,4000),.0399);
 close(officialTokenCost('gpt-6.2-sol',272000,1000),.554);
 close(officialTokenCost('gpt-6.2-sol',272001,1000),1.103004);
 close(officialTokenCost('claude-opus-4-6',100000,1000,50000,40000,10000),.3875);
 close(officialTokenCost('claude-opus-4-6-20260205',100000,1000,50000,40000,10000),.3875);
 close(officialTokenCost('claude-haiku-5-5',100001,1000,90000),.0120005);
 close(officialTokenCost('deepseek-v4-pro',1000000,1000000),5.28);
 assert.equal(officialTokenCost('unknown',100,10),null);
 assert.equal(officialTokenCost('gpt-6.2-sol-custom',100,10),null);
 assert.equal(officialTokenCost('gpt-5.2-pro',100,10,50),null);
 assert.equal(officialTokenCost('gpt-6.2-sol',100,10,80,30),null);
 assert.equal(officialTokenCost('claude-opus-4-6',100,10,0,10,11),null);
});

test('legacy HTTP 200 failures stay unconfirmed while explicit new failures remain failures', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-stats-legacy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));init(root);
 const now=Date.now(),directory=path.join(root,'usage');fs.mkdirSync(directory);
 const common={at:now,client:'codex',provider:'relay',model:'gpt-6.1-sol',status:200,outcome:'failed',durationMs:100};
 const entries=[common,{...common,schema:2},{...common,status:429},{...common,schema:2,outcome:'unknown'},{...common,schema:2,outcome:'success',input:10,output:1}];
 const file=path.join(directory,new Date(now).toISOString().slice(0,10)+'.jsonl');const raw=entries.map(row=>JSON.stringify(row)).join('\n');fs.writeFileSync(file,raw);
 const data=await usageStats(root,{},now);assert.equal(data.summary.requests,5);assert.equal(data.summary.success,1);assert.equal(data.summary.unknown,2);
 assert.equal(data.rows.filter(row=>row.outcome==='failed').length,2);assert.equal(fs.readFileSync(file,'utf8'),raw);
});
