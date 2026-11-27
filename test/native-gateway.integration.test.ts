import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { addProvider, editProvider, activate, init, readState, atomic } from '../src/store.js';
import { checkpoint, expandContext } from '../src/compaction.js';
import { parse } from 'smol-toml';
import { prepareConfig } from '../src/install.js';

const binary = process.env.SWITCH_TEST_NATIVE_GATEWAY;
const desktop = process.env.SWITCH_TEST_NATIVE_DESKTOP;
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const codexClient = process.env.SWITCH_TEST_CODEX;
const serviceWorker = fileURLToPath(new URL('../src/service-worker.js', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = (type, details = {}) => 'event: ' + type + '\r\ndata: ' + JSON.stringify({ type, ...details }) + '\r\n\r\n';
const answer = name => event('response.created') + event('response.output_text.delta', { delta: name }) + event('response.completed', { response: { output: [] } });

async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch {}
    await wait(50);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function listener(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    handler(req, res, raw ? JSON.parse(raw) : null);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + server.address().port;
}

function roots(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-native-'));
  const codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude-cli'), claudeDesktop = path.join(root, 'desktop');
  const data = path.join(root, 'providers'), claude = path.join(data, 'claude');
  fs.mkdirSync(codexHome); fs.mkdirSync(path.join(claudeDesktop, 'Claude'), { recursive: true });
  const token = init(data).token, claudeToken = init(claude).token;
  const env = { ...process.env, SWITCH_HOME: data, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
    SWITCH_CLAUDE_DESKTOP_HOME: claudeDesktop, FLUID_NODE: process.execPath, FLUID_WORKER: serviceWorker,
    NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };
  return { root, data, claude, token, claudeToken, env, codexHome, claudeHome, claudeDesktop,
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

async function start(tool, fixture, args, override) {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(tool, args, { env: { ...fixture.env, SWITCH_PORT: String(override ?? port) }, stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = once(child, 'exit');
  const base = 'http://127.0.0.1:' + (override ?? port);
  async function call(route, payload, headers, token = fixture.token) {
    return fetch(base + route, { method: payload == null ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token,
      'content-type': 'application/json', ...headers }, body: payload == null ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  }
  return { base, child, exited, call, async close(signal = 'SIGTERM') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited;
  } };
}

function sse(res, content) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(content); }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '2' }); res.end(JSON.stringify(body)); }

test('native gateway keeps sessions and model choices across manual switches, quota failover and compaction', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture = roots(t);
  let app;
  t.after(async () => { await app?.close(); fixture.close(); });
  const received = [];
  let first = 'ok', backup = 'ok';
  const primary = await listener(t, (req, res, body) => {
    if (req.method === 'GET') return json(res, 200, { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-image-2' }] });
    received.push(['primary', req.url, req.headers, body]);
    if (first === 'quota') return sse(res, event('response.created') + event('response.failed', { response: { error: { code: 'insufficient_quota' } } }));
    if (first === 'temporary') return json(res, 503, { error: { message: 'temporary upstream error' } });
    if (first === 'policy') return json(res, 403, { error: { message: 'content_policy violation' } });
    if (first === 'late') return sse(res, event('response.output_text.delta', { delta: 'already sent' }) + event('response.failed', { response: { error: { code: 'insufficient_quota' } } }));
    sse(res, answer('primary'));
  });
  const alternate = await listener(t, (req, res, body) => {
    if (req.method === 'GET') return json(res, 200, { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] });
    received.push(['backup', req.url, req.headers, body]);
    if (backup === 'temporary') return json(res, 502, { error: { message: 'backup unreachable' } });
    if (req.url.includes('/images/')) return json(res, 200, { data: [{ b64_json: 'aW1hZ2U=' }] });
    if (body.input?.at?.(-1)?.content?.startsWith('Create a concise')) {
      return sse(res, event('response.completed', { response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'A portable summary' }] }] } }));
    }
    sse(res, answer('backup'));
  });
  addProvider('primary', { type: 'api', baseUrl: primary + '/v1', apiKey: 'fixture-a' }, fixture.data);
  addProvider('backup', { type: 'api', baseUrl: alternate + '/v1', apiKey: 'fixture-b' }, fixture.data);
  app = await start(binary, fixture, ['--service']);
  await until(async () => (await app.call('/health')).ok, 'gateway startup');
  assert.equal((await app.call('/v1/models', null, {}, 'wrong-key')).status, 401);
  const available = await (await app.call('/v1/models?client_version=0.171.0')).json();
  assert.deepEqual(available.models.map(row => row.slug), ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.ok(available.models[0].supported_reasoning_levels.some(level => level.effort === 'xhigh'));
  editProvider('primary', { modelContexts: { 'gpt-6.1-sol': { window: 128000, compact: 96000 } } }, fixture.data);
  editProvider('backup', { modelContexts: { 'gpt-6.1-sol': { window: 200000, compact: 180000 } } }, fixture.data);
  const currentCatalog = async () => (await (await app.call('/v1/models?client_version=0.171.0')).json()).models[0];
  assert.equal((await currentCatalog()).context_window, 128000);
  activate('backup', fixture.data);
  assert.equal((await currentCatalog()).context_window, 200000);
  assert.equal((await currentCatalog()).auto_compact_token_limit, 180000);
  activate('primary', fixture.data);
  const payload = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'task history' }], store: true };
  for (const phase of ['temporary', 'policy', 'late']) {
    first = phase;
    const before = received.length;
    const result = await app.call('/v1/responses', payload);
    assert.equal(result.status, { temporary: 503, policy: 403, late: 200 }[phase]);
    if (phase === 'temporary') assert.equal(result.headers.get('retry-after'), '2');
    await result.text();
    assert.deepEqual(received.slice(before).map(entry => entry[0]), ['primary']);
    assert.equal(readState(fixture.data).active, 'primary');
  }
  first = 'quota'; backup = 'temporary';
  assert.equal((await app.call('/v1/responses', payload)).status, 502);
  assert.equal(readState(fixture.data).active, 'primary');
  activate('primary', fixture.data);
  backup = 'ok';
  const fallback = await app.call('/v1/responses', payload);
  assert.match(await fallback.text(), /backup/);
  assert.equal(readState(fixture.data).active, 'backup');
  assert.equal(readState(fixture.data).lastFailover.status, 429);
  assert.deepEqual(received.at(-1)[3].input, payload.input);
  assert.equal(received.at(-1)[3].store, false);
  assert.equal(received.at(-1)[2].authorization, 'Bearer fixture-b');
  assert.equal(received.at(-1)[2]['x-fluid-token'], undefined);
  first = 'ok'; activate('primary', fixture.data);
  const selectedModel = await app.call('/v1/responses', { ...payload, model: 'gpt-6-astra' });
  assert.equal(selectedModel.headers.get('x-switch-alias'), 'backup'); await selectedModel.text();
  assert.equal(readState(fixture.data).active, 'primary');
  assert.equal(received.at(-1)[3].model, 'gpt-6-astra');
  const switched = await app.call('/v1/responses', payload);
  assert.equal(switched.headers.get('x-switch-alias'), 'primary'); await switched.text();
  activate('backup', fixture.data);
  const old = checkpoint('Read the TypeScript checkpoint', fixture.token);
  const compact = await (await app.call('/v1/responses/compact', { ...payload, input: [...payload.input, old] })).json();
  assert.equal(expandContext(compact.output, fixture.token)[0].content[0].text, 'A portable summary');
  assert.equal(received.at(-1)[3].input[1].content[0].text, 'Read the TypeScript checkpoint');
  const nativeImage = await app.call('/v1/images/generations', { prompt: 'fixture' });
  assert.equal((await nativeImage.json()).data[0].b64_json, 'aW1hZ2U=');
  assert.equal(readState(fixture.data).active, 'backup');
});

test('native Codex and Claude fail over opaque HTTP 400 rejections before output without replaying validation, policy or accepted output', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture=roots(t);let app,mode='http';const seen=[];
  t.after(async()=>{await app?.close();fixture.close();});
  for(const alias of ['a','b']){
    const upstream=await listener(t,(req,res,body)=>{
      if(req.method==='GET')return json(res,200,{data:[{id:'test'}]});
      const claude=req.url.includes('messages');seen.push({alias,body});
      if(alias==='b')return claude?json(res,200,{type:'message',content:[]}):sse(res,answer('backup'));
      if(mode==='http'){res.writeHead(400);res.end();return;}
      if(mode==='validation')return json(res,400,{error:{code:'invalid_json',message:'Invalid JSON'}});
      if(mode==='policy')return json(res,400,{error:{code:'content_policy_violation'}});
      const prefix=mode==='late'?(claude?event('content_block_delta',{delta:{type:'text_delta',text:'accepted'}}):event('response.output_text.delta',{delta:'accepted'})):'';
      const rejection=claude?event('error',{error:{type:'invalid_request_error',message:'Bad Request'}}):event('response.failed',{response:{error:{type:'invalid_request_error',message:'Bad Request'}}});
      sse(res,prefix+rejection);
    });
    for(const root of [fixture.data,fixture.claude])addProvider(alias,{type:'api',baseUrl:upstream+'/v1',apiKey:'secret-'+alias},root);
  }
  app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'gateway startup');
  for(const claude of [false,true])for(const selected of ['http','startup','validation','policy','late']){
    mode=selected;seen.length=0;activate('a',claude?fixture.claude:fixture.data);
    const payload=claude?{model:'test',messages:[{role:'user',content:'history'}],output_config:{effort:'high'}}:{model:'test',input:[{role:'user',content:'history'}],reasoning:{effort:'high'}};
    const response=await app.call(claude?'/claude/v1/messages':'/v1/responses',payload,{},claude?fixture.claudeToken:fixture.token);await response.text();
    const fallback=['http','startup'].includes(mode);
    assert.deepEqual(seen.map(row=>row.alias),fallback?['a','b']:['a'],`${claude?'Claude':'Codex'} ${mode}`);
    if(fallback){assert.equal(response.status,200);assert.equal(response.headers.get('x-switch-alias'),'b');assert.deepEqual(seen[0].body,seen[1].body);}
  }
});

test('native gateway enriches new API model efforts from the matching Codex and preserves explicit upstream capabilities', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
 const fixture=roots(t);let app;t.after(async()=>{await app?.close();fixture.close();});
 const helper=path.join(fixture.root,'codex-helper');fs.writeFileSync(helper,"#!/bin/sh\nprintf 'codex-cli 0.171.0\\n'\n",{mode:0o755});
 fs.writeFileSync(path.join(fixture.root,'version.txt'),'fixture');
 const efforts=['low','medium','high','xhigh','max','ultra'];
 fs.writeFileSync(path.join(fixture.root,'model-metadata.json'),JSON.stringify({version:'fixture',models:[
  {id:'gpt-6.2-sol',label:'Current Sol',efforts,defaultEffort:'low'},
  {id:'gpt-6.2-astra',label:'Current Astra',efforts,defaultEffort:'low'},
  {id:'not-offered',label:'Unavailable',efforts,defaultEffort:'low'},
 ]}));
 fixture.env.SWITCH_CODEX_BIN=helper;
 const primary=await listener(t,(_req,res)=>json(res,200,{data:[
  {id:'gpt-6.2-sol'},
  {id:'gpt-6.2-astra',supported_reasoning_levels:[{effort:'high',description:'Upstream high'}],default_reasoning_level:'high'},
  {id:'vendor-model',supported_reasoning_levels:[]},
 ]}));
 addProvider('api',{type:'api',baseUrl:primary+'/v1',apiKey:'fixture'},fixture.data);
 app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'gateway startup');
 const {models}=await(await app.call('/v1/models?client_version=0.171.0')).json();
 assert.deepEqual(models.map(model=>model.slug),['gpt-6.2-sol','gpt-6.2-astra','vendor-model']);
 assert.deepEqual(models[0].supported_reasoning_levels.map(level=>level.effort),efforts);assert.equal(models[0].default_reasoning_level,'low');
 assert.deepEqual(models[1].supported_reasoning_levels,[{effort:'high',description:'Upstream high'}]);assert.equal(models[1].default_reasoning_level,'high');
 assert.deepEqual(models[2].supported_reasoning_levels,[]);
});

test('native worker selects desktop and VS Code metadata independently when their Codex versions differ', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
 const fixture=roots(t);let app;t.after(async()=>{await app?.close();fixture.close();});
 const old='0.170.0',current='0.172.0',id='gpt-6.2-sol';
 const desktop=path.join(fixture.root,'desktop-client','codex');
 const editor=path.join(fixture.root,'extensions','openai.chatgpt-26.1127.1','bin',`${process.platform==='darwin'?'macos':'linux'}-${process.arch==='arm64'?'aarch64':'x86_64'}`,'codex');
 for(const [file,version,efforts] of [[desktop,old,['low']],[editor,current,['low','high','ultra']]]){
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,{mode:0o755});
  fs.writeFileSync(path.join(path.dirname(file),'version.txt'),version);
  fs.writeFileSync(path.join(path.dirname(file),'model-metadata.json'),JSON.stringify({version,models:[{id,label:id,efforts,defaultEffort:'low'}]}));
 }
 fixture.env.SWITCH_CODEX_BIN=desktop;fixture.env.VSCODE_EXTENSIONS=path.join(fixture.root,'extensions');
 const upstream=await listener(t,(_req,res)=>json(res,200,{data:[{id}]}));addProvider('api',{type:'api',baseUrl:upstream+'/v1',apiKey:'fixture'},fixture.data);
 app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'gateway startup');
 for(const version of [old,current,old,current]){
  const {models}=await(await app.call('/v1/models',null,{'user-agent':`codex_vscode/${version}`,originator:'codex_vscode'})).json();
  assert.deepEqual(models[0].supported_reasoning_levels.map(level=>level.effort),version===old?['low']:['low','high','ultra']);
 }
});

test('native model union survives partial upstream capabilities and is readable by the VS Code Codex app-server', {
  skip: !binary || process.platform === 'win32', timeout: 30000,
}, async t => {
  const fixture = roots(t);
  let app, child, exited;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    await exited; await app?.close(); fixture.close();
  });
  const requests = [], catalogs = []; let unavailable = false;
  const model = 'gpt-6.2-sol';
  for (const alias of ['partial', 'healthy', 'offline']) {
    const upstream = await listener(t, (req, res, body) => {
      if (req.method === 'GET') {
        catalogs.push(alias);
        if (alias === 'offline' || unavailable) return json(res, 503, { error: { message: 'Unavailable' } });
        return json(res, 200, { data: alias === 'healthy' ? [{ id: model }, { id: 'healthy-only' }] : [
          { id: model, supported_reasoning_levels: null, shell_type: null, visibility: null, support_verbosity: null },
          { id: 'partial-only', supported_reasoning_levels: [{ effort: 'high' }, null, { effort: 'high' }, {}], default_reasoning_level: 'invalid' },
          { id: 'string-efforts', supported_reasoning_levels: ['low', 'high'], experimental_supported_tools: null, truncation_policy: null, default_reasoning_summary: null },
          { id: 'gpt-6-luna', supported_reasoning_levels: [], default_reasoning_level: null },
          { id: 'gpt-image-2' },
        ] });
      }
      requests.push(body);
      sse(res, event('response.created', { response: { id: 'resp_fixture', output: [] } })
        + event('response.completed', { response: { id: 'resp_fixture', status: 'completed', output: [] } }));
    });
    addProvider(alias, { type: 'api', baseUrl: upstream + '/v1', apiKey: 'fixture-' + alias }, fixture.data);
  }
  if (codexClient) fixture.env.SWITCH_CODEX_BIN = codexClient;
  app = await start(binary, fixture, ['--service']);
  await until(async () => (await app.call('/health')).ok, 'gateway startup');
  const { models } = await (await app.call('/v1/models?client_version=0.171.0')).json();
  const ids = [model, 'gpt-6-luna', 'healthy-only', 'partial-only', 'string-efforts'];
  assert.deepEqual(models.map(item => item.slug), ids);
  assert.deepEqual([...catalogs].sort(), ['healthy', 'offline', 'partial']);
  assert.equal(models[0].shell_type, 'shell_command'); assert.equal(models[0].visibility, 'list');
  assert.deepEqual(models[1].supported_reasoning_levels, []);
  assert.deepEqual(models[3].supported_reasoning_levels, [{ effort: 'high', description: 'high' }]);
  assert.equal(models[3].default_reasoning_level, 'high');
  assert.deepEqual(models[4].supported_reasoning_levels, [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }]);
  assert.deepEqual(models[4].experimental_supported_tools, []);
  assert.deepEqual(models[4].truncation_policy, { mode: 'tokens', limit: 10000 });
  if (!codexClient) return;
  fs.writeFileSync(path.join(fixture.codexHome, 'config.toml'), `model="${model}"\n`);
  prepareConfig(fixture.data, fixture.codexHome, Number(new URL(app.base).port), fixture.token).apply();
  child = spawn(codexClient, ['app-server'], { cwd: fixture.root, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  const { createInterface } = await import('node:readline');
  const pending = new Map(); let id = 0, stderr = '', finish;
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
    if (message.method === 'turn/completed') finish?.(message.params.turn);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await call('initialize', { clientInfo: { name: 'codex_vscode', version: '26.1120.50957' }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const listed = await call('model/list', { modelProvider: 'fluid', includeHidden: false, limit: 100 });
  assert.deepEqual(listed.data.map(item => item.model), ids, stderr);
  assert.deepEqual(listed.data[0].supportedReasoningEfforts.map(level => level.reasoningEffort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(listed.data[1].supportedReasoningEfforts, []);
  assert.deepEqual(listed.data[3].supportedReasoningEfforts, [{ reasoningEffort: 'high', description: 'high' }]);
  const { thread } = await call('thread/start', { cwd: fixture.root, approvalPolicy: 'never', sandbox: 'read-only' });
  const done = new Promise(resolve => { finish = resolve; });
  await call('turn/start', { threadId: thread.id, effort: 'high', input: [{ type: 'text', text: 'Check effort', text_elements: [] }] });
  assert.equal((await done).status, 'completed', stderr);
  assert.equal(requests[0].model, model); assert.equal(requests[0].reasoning.effort, 'high');
  assert.doesNotMatch(stderr, /failed to decode models response/);
  child.kill(); await exited; await app.close(); unavailable = true;
  app = await start(binary, fixture, ['--service']);
  await until(async () => (await app.call('/health')).ok, 'gateway restart');
  const cached = await (await app.call('/v1/models?client_version=0.171.0')).json();
  assert.deepEqual(cached.models.map(item => item.slug), ids, 'saved partial upstream metadata remains readable after restart');
  assert.deepEqual(cached.models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('native gateway exposes Claude model unions and preserves explicit mappings and SSE semantics', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture = roots(t);
  let app;
  t.after(async () => { await app?.close(); fixture.close(); });
  const seen = [];
  const relay = name => listener(t, (req, res, body) => {
    if (req.method === 'GET') return json(res, 200, { data: [{ id: 'deepseek-v4-pro' }, { id: name === 'a' ? 'deepseek-v4-flash' : 'deepseek-v4-1-flash' }] });
    seen.push([name, body.model, req.url, req.headers]);
    if (name === 'a' && body.model === 'deepseek-v4-pro') return sse(res, event('message_start') + event('error', { error: { type: 'rate_limit_error', message: 'quota' } }));
    if (req.url.includes('count_tokens')) return json(res, 200, { input_tokens: 42 });
    sse(res, event('message_start') + event('content_block_start', { content_block: { type: 'text', text: '' } }) + event('message_stop'));
  });
  for (const name of ['a', 'b']) addProvider(name,
    { type: 'api', baseUrl: await relay(name), apiKey: 'fixture-' + name, claudeModels: { opus: 'deepseek-v4-pro', haiku: name === 'a' ? 'deepseek-v4-flash' : 'deepseek-v4-1-flash' } }, fixture.claude);
  app = await start(binary, fixture, ['--service']);
  await until(async () => (await app.call('/health')).ok, 'Claude gateway startup');
  const req = (route, payload, headers) => app.call('/claude/v1/' + route, payload, headers, fixture.claudeToken);
  const models = (await (await req('models')).json()).data;
  assert.deepEqual(models.map(model => model.display_name), ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-1-flash']);
  const messages = [{ role: 'user', content: 'previous turn' }];
  const result = await req('messages', { model: models[0].id + '[1m]', messages }, { 'x-claude-code-agent-id': 'fixture' });
  assert.equal(result.headers.get('x-switch-alias'), 'b'); assert.match(await result.text(), /content_block_start/);
  assert.deepEqual(seen.map(row => row.slice(0, 2)), [['a', 'deepseek-v4-pro'], ['b', 'deepseek-v4-pro']]);
  assert.equal(seen.at(-1)[3].authorization, 'Bearer fixture-b');
  assert.equal(readState(fixture.claude).active, 'b');
  const legacy = models[0].id.replace('claude-fluid-', 'claude-sonnet-5-');
  const resumed = await req('messages', { model: legacy, messages });
  assert.equal(resumed.headers.get('x-switch-alias'), 'b'); await resumed.text();
  assert.equal(seen.at(-1)[1], 'deepseek-v4-pro');
  const tokens = await req('messages/count_tokens?beta=true', { model: 'haiku', messages });
  assert.equal((await tokens.json()).input_tokens, 42);
  assert.deepEqual(seen.at(-1).slice(0, 3), ['b', 'deepseek-v4-1-flash', '/v1/messages/count_tokens?beta=true']);
});

test('native Claude model discovery isolates desktop and editor capabilities and forwards the actual client protocol', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture=roots(t);let app;t.after(async()=>{await app?.close();fixture.close();});
  const reads=[];
  const upstream=await listener(t,(req,res)=>{
    reads.push(req.headers);
    const desktop=req.headers['user-agent']==='claude-desktop/1.0';
    json(res,200,{data:[{id:'claude-sonnet-test',display_name:desktop?'Desktop':'Editor',capabilities:{effort:{supported_efforts:desktop?['low','high']:['low','high','max']}},max_input_tokens:desktop?100000:200000}]});
  });
  addProvider('api',{type:'api',baseUrl:upstream,apiKey:'upstream-key'},fixture.claude);
  app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'Claude gateway startup');
  for(const desktop of [true,false,true,false]){
    const headers={'user-agent':desktop?'claude-desktop/1.0':'claude-cli/2.0','anthropic-version':desktop?'2023-06-01':'2024-01-01','anthropic-beta':desktop?'desktop-fixture':'editor-fixture'};
    const response=await app.call((desktop?'/claude-desktop':'/claude')+'/v1/models',null,headers,fixture.claudeToken);
    const {data}=await response.json();assert.equal(response.status,200);
    assert.equal(data[0].display_name,desktop?'Desktop':'Editor');
    assert.deepEqual(data[0].capabilities.effort.supported_efforts,desktop?['low','high']:['low','high','max']);
    assert.equal(data[0].max_input_tokens,desktop?100000:200000);
  }
  assert.equal(reads.length,2,'each client reuses its own discovery cache');
  assert.equal(reads[1]['anthropic-beta'],'editor-fixture');assert.equal(reads[1]['anthropic-version'],'2024-01-01');
  assert.ok(reads.every(headers=>headers.authorization==='Bearer upstream-key'));
});

test('the packaged desktop confirms startup and recovers both clients after termination', { skip: !desktop, timeout: 45000 }, async t => {
  const fixture = roots(t);
  let app;
  t.after(async () => { await app?.close('SIGKILL'); fixture.close(); });
  const codex = path.join(fixture.codexHome, 'config.toml');
  const claude = path.join(fixture.claudeHome, 'settings.json');
  const profile = path.join(fixture.claudeDesktop, 'Claude', 'claude_desktop_config.json');
  const original = '# Original settings\nmodel="gpt-6.1-sol"\n';
  fs.writeFileSync(codex, original);
  fs.writeFileSync(profile, '{"deploymentMode":"1p"}\n');
  addProvider('codex-test', { type: 'api', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, fixture.data);
  addProvider('claude-test', { type: 'api', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture' }, fixture.claude);
  const receipt = path.join(fixture.data, 'updates', 'pending.json');
  atomic(receipt, { version, token: 'fixture-receipt', ready: false, executable: desktop });
  app = await start(desktop, fixture, ['--hidden']);
  await until(() => JSON.parse(fs.readFileSync(receipt)).ready, 'startup confirmation', 30000);
  assert.equal(parse(fs.readFileSync(codex, 'utf8')).model_provider, 'fluid');
  assert.equal(JSON.parse(fs.readFileSync(profile)).deploymentMode, '3p');
  assert.equal(fs.existsSync(claude), true);
  await app.close('SIGKILL');
  await until(() => fs.readFileSync(codex, 'utf8') === original && !fs.existsSync(claude) &&
    JSON.parse(fs.readFileSync(profile)).deploymentMode === '1p', 'crash recovery');
  assert.equal(JSON.parse(fs.readFileSync(receipt)).token, 'fixture-receipt');
});

test('the installed Codex keeps one thread and its effort when the native gateway switches providers', {
  skip: !binary || !codexClient || process.platform === 'win32', timeout: 30000,
}, async t => {
  const fixture = roots(t);
  const requests = [];
  const model = 'gpt-6.1-sol';
  for (const alias of ['first', 'second']) {
    const upstream = await listener(t, (req, res, body) => {
      if (req.method === 'GET') return json(res, 200, { data: [{ id: model }] });
      requests.push({ alias, body });
      if (alias === 'first' && requests.length > 2) return json(res, 429, { error: { code: 'insufficient_quota' } });
      const item = {
        id: 'msg_' + requests.length, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'reply from ' + alias, annotations: [] }],
      };
      const response = { id: 'resp_' + requests.length, status: 'completed', output: [item], usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } };
      sse(res, event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
        + event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
        + event('response.output_item.done', { output_index: 0, item })
        + event('response.completed', { response }));
    });
    addProvider(alias, { type: 'api', baseUrl: upstream + '/v1', apiKey: 'fixture-' + alias }, fixture.data);
  }
  let gateway, child, exited;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await gateway?.close();
    fixture.close();
  });
  gateway = await start(binary, fixture, ['--service']);
  await until(async () => (await gateway.call('/health')).ok, 'gateway startup');
  fs.writeFileSync(path.join(fixture.codexHome, 'config.toml'), 'model="' + model + '"\n');
  prepareConfig(fixture.data, fixture.codexHome, Number(new URL(gateway.base).port), fixture.token).apply();
  editProvider('first', { modelContexts: { [model]: { window: 128000, compact: 96000 } } }, fixture.data);
  editProvider('second', { modelContexts: { [model]: { window: 200000, compact: 180000 } } }, fixture.data);
  const { createInterface } = await import('node:readline');
  child = spawn(codexClient, ['app-server', '--stdio'], { cwd: fixture.root, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  let stderr = '', id = 0;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map(), completed = new Map(), usage = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
    if (message.method === 'thread/tokenUsage/updated') usage.push(message.params.tokenUsage);
    if (message.method === 'turn/completed') completed.get(message.params.threadId)?.(message.params.turn);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await call('initialize', { clientInfo: { name: 'fluid_native_test', version: '1.0.0' } });
  child.stdin.write('{"method":"initialized"}\n');
  const { config } = await call('config/read', { cwd: fixture.root });
  assert.equal(config.model_context_window, null);
  assert.equal(config.model_auto_compact_token_limit, null);
  const selected = await call('model/list', { includeHidden: false });
  assert.ok(selected.data.some(item => item.model === model));
  const { thread } = await call('thread/start', { cwd: fixture.root, approvalPolicy: 'never', sandbox: 'read-only' });
  for (const [alias, message] of [['first', 'First turn'], ['second', 'Second turn'], ['first', 'Third turn']]) {
    activate(alias, fixture.data);
    const done = new Promise(resolve => completed.set(thread.id, resolve));
    await call('turn/start', { threadId: thread.id, effort: 'high', input: [{ type: 'text', text: message, text_elements: [] }] });
    assert.equal((await done).status, 'completed', stderr);
  }
  assert.deepEqual(requests.map(request => request.alias), ['first', 'second', 'first', 'second']);
  assert.ok(requests.every(({ body }) => body.model === model && body.reasoning?.effort === 'high'));
  assert.deepEqual(requests[2].body.input, requests[3].body.input);
  for (const turn of ['First turn', 'Second turn', 'Third turn']) assert.match(JSON.stringify(requests[3].body.input), new RegExp(turn));
  assert.equal(readState(fixture.data).active, 'second');
  assert.ok(usage.some(item => item.modelContextWindow === 121600), JSON.stringify(usage));
});

test('disabled providers are excluded from catalog, fallback and image routes; usage survives restart without response content', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture = roots(t); let app; t.after(async()=>{await app?.close();fixture.close();});
  const seen=[];
  const upstream=await listener(t,(req,res,body)=>{
    if(req.method==='GET')return json(res,200,{data:[{id:'shared-model'}]});
    seen.push(req.headers.authorization);
    if(req.headers.authorization==='Bearer first')return json(res,402,{error:{message:'insufficient credits'}});
    sse(res,event('response.created')+event('response.output_text.delta',{delta:'PRIVATE_RESPONSE'})+event('response.completed',{response:{model:body.model,usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:80}},output:[]}}));
  });
  addProvider('first',{type:'api',baseUrl:upstream+'/v1',apiKey:'first',modelCatalog:[{id:'shared-model',label:'shared-model'}]},fixture.data);
  addProvider('off',{type:'api',baseUrl:upstream+'/v1',apiKey:'disabled',modelCatalog:[{id:'hidden-model',label:'hidden'}]},fixture.data);
  addProvider('backup',{type:'api',baseUrl:upstream+'/v1',apiKey:'backup',modelCatalog:[{id:'shared-model',label:'shared-model'}]},fixture.data);
  editProvider('off',{enabled:false},fixture.data);
  app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'startup');
  const catalog=await(await app.call('/v1/models')).json();assert.ok(!catalog.models.some(row=>row.slug==='hidden-model'));
  const response=await app.call('/v1/responses',{model:'shared-model',input:'PRIVATE_PROMPT'});assert.match(await response.text(),/PRIVATE_RESPONSE/);assert.deepEqual(seen,['Bearer first','Bearer backup']);
  const {usageStats}=await import('../src/usage-stats.js');
  await until(async()=>(await usageStats(fixture.data)).summary.requests===2,'persisted usage');
  const stats=await usageStats(fixture.data);assert.equal(stats.summary.success,1);assert.equal(stats.summary.input,100);assert.equal(stats.summary.cached,80);assert.equal(stats.summary.output,10);
  const bytes=fs.readdirSync(path.join(fixture.data,'usage')).map(name=>fs.readFileSync(path.join(fixture.data,'usage',name),'utf8')).join('');assert.doesNotMatch(bytes,/PRIVATE_PROMPT|PRIVATE_RESPONSE|Bearer/);
  editProvider('first',{enabled:false},fixture.data);editProvider('backup',{enabled:false},fixture.data);const before=seen.length;
  assert.equal((await app.call('/v1/responses',{model:'shared-model',input:'no'})).status,409);assert.equal(seen.length,before);
  editProvider('off',{enabled:true},fixture.data);assert.equal(readState(fixture.data).active,'off');
  await app.close();app=null;assert.equal((await usageStats(fixture.data)).summary.requests,2);
});

test('Claude disabled providers never receive requests and JSON/SSE usage is recorded once per attempt', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
 const fixture=roots(t);let app;t.after(async()=>{await app?.close();fixture.close();});const seen=[];
 const upstream=await listener(t,(req,res,body)=>{
  if(req.method==='GET')return json(res,200,{data:[{id:'deepseek-v4-pro'}]});seen.push(req.headers['x-api-key']);
  const message={id:'message-test',model:'deepseek-v4-pro',content:[],usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:90,cache_creation_input_tokens:20}};
  if(body.stream)sse(res,event('message_start',{message:{...message,usage:{...message.usage,output_tokens:0}}})+event('content_block_delta',{delta:{type:'text_delta',text:'PRIVATE'}})+event('message_delta',{usage:{output_tokens:5}})+event('message_stop'));
  else json(res,200,message);
 });
 const provider=key=>({type:'api',apiKey:key,baseUrl:upstream,modelCatalog:[{id:'deepseek-v4-pro',label:'DeepSeek'}]});
 addProvider('first',provider('first'),fixture.claude);addProvider('backup',provider('backup'),fixture.claude);editProvider('first',{enabled:false},fixture.claude);
 app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'startup');
 for(const stream of [false,true]){const response=await app.call('/claude/v1/messages',{model:'deepseek-v4-pro',messages:[{role:'user',content:'PRIVATE'}],max_tokens:10,stream},{},fixture.claudeToken);assert.equal(response.status,200);await response.text();}
 assert.deepEqual(seen,['backup','backup']);
 const {usageStats}=await import('../src/usage-stats.js');await until(async()=>(await usageStats(fixture.data)).summary.requests===2,'claude usage');const data=await usageStats(fixture.data);assert.equal(data.summary.success,2);assert.equal(data.summary.input,240);assert.equal(data.summary.cached,180);assert.equal(data.summary.output,10);
 const hidden=await(await app.call('/claude/v1/models',null,{},fixture.claudeToken)).json();assert.equal(hidden.data.length,1);
});

test('large terminal events retain usage and successful status without storing generated content', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
 const fixture=roots(t);let app;t.after(async()=>{await app?.close();fixture.close();});
 const output='PRIVATE_ENCRYPTED_CONTENT_'.repeat(10000);
 const terminal=event('response.completed',{response:{model:'gpt-6.1-sol',output:[{type:'reasoning',encrypted_content:output}],usage:{input_tokens:90000,output_tokens:2000,input_tokens_details:{cached_tokens:80000}}}});
 const upstream=await listener(t,(req,res,body)=>{
  if(req.method==='GET')return json(res,200,{data:[{id:'gpt-6.1-sol'}]});
  sse(res,event('response.created')+event('response.output_text.delta',{delta:'ok'})+terminal);
 });
 addProvider('relay',{type:'api',baseUrl:upstream+'/v1',apiKey:'fixture',modelCatalog:[{id:'gpt-6.1-sol',label:'Model'}]},fixture.data);
 app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'startup');
 const response=await app.call('/v1/responses',{model:'gpt-6.1-sol',input:'PRIVATE_PROMPT'});assert.equal(response.status,200);assert.ok((await response.text()).endsWith(terminal));
 const {usageStats}=await import('../src/usage-stats.js');await until(async()=>(await usageStats(fixture.data)).summary.requests===1,'large completion usage');
 const stats=await usageStats(fixture.data);assert.equal(stats.summary.success,1);assert.equal(stats.summary.input,90000);assert.equal(stats.summary.output,2000);assert.equal(stats.summary.cached,80000);assert.equal(stats.rows[0].outcome,'success');
 const raw=fs.readdirSync(path.join(fixture.data,'usage')).map(name=>fs.readFileSync(path.join(fixture.data,'usage',name),'utf8')).join('');assert.doesNotMatch(raw,/PRIVATE|ENCRYPTED|fixture/);
});

test('image route aliases preserve client query parameters and edit references', { skip: !binary || process.platform === 'win32', timeout: 30000 }, async t => {
 const fixture=roots(t);let app;t.after(async()=>{await app?.close();fixture.close();});const seen=[];
 const upstream=await listener(t,(req,res,body)=>{seen.push([req.url,body]);json(res,200,{created:1,data:[{b64_json:'aW1hZ2U='}]});});
 addProvider('images',{type:'api',baseUrl:upstream+'/v1',apiKey:'fixture'},fixture.data);
 app=await start(binary,fixture,['--service']);await until(async()=>(await app.call('/health')).ok,'startup');
 for(const route of ['/images/generations','/v1/images/generations','/v1/v1/images/generations','/codex/v1/images/edits']){
  const payload={prompt:'fixture',images:[{image_url:'data:image/png;base64,aW1hZ2U='}]};
  const response=await app.call(route+'?client_version=0.165.0&api-version=CaseValue',payload);assert.equal(response.status,200);await response.text();
  assert.equal(seen.at(-1)[0],'/v1/images/'+(route.endsWith('edits')?'edits':'generations')+'?client_version=0.165.0&api-version=CaseValue');assert.deepEqual(seen.at(-1)[1],payload);
 }
});
