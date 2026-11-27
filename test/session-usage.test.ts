import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSessionUsage } from '../src/session-usage.js';
import { usageStats } from '../src/usage-stats.js';

test('session usage reads incremental LF/CRLF logs, deduplicates token events and leaves partial lines pending', async t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'switch-session-usage-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const directory=path.join(home,'sessions','2026','11','25');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'rollout-fixture.jsonl'),at=new Date().toISOString();
 const event=(type,payload)=>JSON.stringify({timestamp:at,type,payload});
 const usage={input_tokens:100,cached_input_tokens:80,output_tokens:10,cache_write_input_tokens:5};
 const token=event('event_msg',{type:'token_count',info:{last_token_usage:usage,total_token_usage:usage}});
 const lines=[event('turn_context',{model:'gpt-6.1-sol'}),event('response_item',{content:'PRIVATE'.repeat(30000)}),event('token_usage_record',{response_id:'r1',usage}),token,token];
 fs.writeFileSync(file,lines.join('\r\n')+'\r\n');
 let rows=await codexSessionUsage(home,Date.now()-86400000);assert.equal(rows.length,1);assert.equal(rows[0].input,100);assert.equal(rows[0].cached,80);assert.equal(rows[0].output,10);assert.equal(rows[0].source,'session');assert.equal(rows[0].model,'gpt-6.1-sol');assert.equal(rows[0].status,0);
 assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
 const second=event('token_usage_record',{response_id:'r2',usage:{...usage,input_tokens:200}});fs.appendFileSync(file,second.slice(0,50));
 assert.equal((await codexSessionUsage(home,Date.now()-86400000)).length,1);
 fs.appendFileSync(file,second.slice(50)+'\n');rows=await codexSessionUsage(home,Date.now()-86400000);assert.equal(rows.length,2);
 assert.equal((await codexSessionUsage(home,Date.now()-86400000)).length,2);
});

test('gateway and session sources are independent and status filtering updates counts',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-stats-filters-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'usage');fs.mkdirSync(dir);const at=Date.now();
 const row={at,client:'codex',provider:'primary',model:'gpt-6.1-sol',outcome:'success',schema:2,durationMs:100,input:100,output:10};
 fs.writeFileSync(path.join(dir,new Date(at).toISOString().slice(0,10)+'.jsonl'),[{...row,status:200},{...row,status:429,outcome:'failed'},{...row,status:200,provider:'backup',model:'gpt-6.2-sol'}].map(r=>JSON.stringify(r)).join('\n'));
 const result=await usageStats(root,{status:200},at);assert.equal(result.summary.requests,2);assert.deepEqual(result.counts,{requests:2,providers:2,models:2});
 assert.equal((await usageStats(root,{source:'session',client:'claude'},at)).summary.requests,0);
});
