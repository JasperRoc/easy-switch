import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { init, atomic, addProvider, editProvider, removeProvider, readState, activate } from '../src/store.js';
import { activateClaude, restoreClaude } from '../src/claude-config.js';
import { claudeBinary, existingClaudeAuth, claudeToken, startClaudeLogin } from '../src/claude-auth.js';
import { discoverClaudeModels } from '../src/catalog.js';
import { createProxy } from '../src/proxy.js';
import { DesktopController } from '../desktop/controller.js';
import { claudeModelEnvironment, claudeModelMapping, mappedClaudeModel } from '../src/claude-models.js';

const oauth = { accessToken: 'subscription-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] };
const sse = 'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"done"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  init(root); init(path.join(root, 'claude')); return root;
}
async function proxy(t, root, options) {
  const server = createProxy({ root, ...options }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const request = (url, token, payload = {}, headers = {}) => fetch(url + '/claude/v1/messages?beta=true', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'claude-client', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }], stream: true, ...payload }) });
const localFiles = home => ({ ...fs, statSync(file) { if (!file.startsWith(home + path.sep)) throw Error(); return fs.statSync(file); } });

test('provider editing preserves keys, active priority and account ownership; failed validation is atomic', t => {
  const root = fixture(t), accountHome = path.join(root, 'accounts', 'original');
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'secret', account_id: 'id' } });
  addProvider('first', { type: 'api', apiKey: 'saved-secret', baseUrl: 'https://example.test/v1' }, root);
  addProvider('account', { type: 'account', accountHome }, root);
  editProvider('first', { alias: 'renamed', baseUrl: 'https://new.test/v1' }, root);
  assert.equal(readState(root).providers.renamed.apiKey, 'saved-secret'); assert.equal(readState(root).active, 'renamed');
  assert.deepEqual(readState(root).order, ['renamed', 'account']);
  const before = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  for (const patch of [{ alias: 'account' }, { baseUrl: 'http://remote.test' }, { apiKey: '' }]) assert.throws(() => editProvider('renamed', patch, root));
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), before);
  editProvider('account', { alias: 'new-account' }, root);
  const controller = new DesktopController({ root, codexHome: path.join(root, 'codex'), claudeHome: path.join(root, 'claude-config'), binary: 'unused' });
  controller.remove('new-account'); assert.equal(fs.existsSync(accountHome), false);
  controller.edit({ original: 'renamed', alias: 'api', url: 'https://another.test/v1', key: '' });
  assert.equal(readState(root).providers.api.apiKey, 'saved-secret');
  assert.ok(!JSON.stringify(controller.snapshot()).includes('saved-secret'));
});

test('Claude settings restore exact original text, preserve concurrent edits and never touch login files', t => {
  const root = fixture(t), directory = path.join(root, 'settings'), file = path.join(directory, 'settings.json');
  fs.mkdirSync(directory); const original = '{"env":{"ANTHROPIC_BASE_URL":"https://original.test","CUSTOM":"yes"},"permissions":{"allow":[]}}\n';
  fs.writeFileSync(file, original); fs.writeFileSync(path.join(directory, '.credentials.json'), 'original-login');
  activateClaude(root, directory, 12345, 'local-token');
  assert.equal(JSON.parse(fs.readFileSync(file)).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:12345/claude');
  activateClaude(root, directory, 12345, 'local-token'); restoreClaude(path.join(root, 'claude-session.json'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  activateClaude(root, directory, 12345, 'local-token');
  const edited = JSON.parse(fs.readFileSync(file)); edited.language = 'Japanese'; edited.env.ANTHROPIC_AUTH_TOKEN = 'user-new-key'; atomic(file, edited);
  restoreClaude(path.join(root, 'claude-session.json'));
  const restored = JSON.parse(fs.readFileSync(file)); assert.equal(restored.language, 'Japanese'); assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'user-new-key');
  assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://original.test'); assert.equal(restored.env.CUSTOM, 'yes');
  assert.equal(fs.readFileSync(path.join(directory, '.credentials.json'), 'utf8'), 'original-login');
});

test('Claude detection finds the newest compatible editor binary without a terminal PATH', t => {
  for (const platform of ['darwin', 'win32']) for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const home = fixture(t), name = platform === 'win32' ? 'claude.exe' : 'claude';
    const install = (version, target = `${platform}-arm64`) => {
      const file = path.join(home, editor, 'extensions', `anthropic.claude-code-${version}-${target}`, 'resources', 'native-binary', name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture', { mode: 0o700 }); return file;
    };
    install('2.1.99'); const latest = install('2.1.100');
    install('2.1.999', 'linux-arm64'); install('2.1.998', `${platform}-x64`);
    const options = { home, platform, arch: 'arm64', env: { PATH: '' }, files: localFiles(home) };
    assert.equal(claudeBinary(options), latest);
    const standalone = path.join(home, '.local', 'bin', name);
    fs.mkdirSync(path.dirname(standalone), { recursive: true }); fs.writeFileSync(standalone, 'fixture', { mode: 0o700 });
    assert.equal(claudeBinary(options), standalone, 'a standalone CLI takes priority over an editor extension');
    assert.equal(claudeBinary({ ...options, env: { SWITCH_CLAUDE_BIN: 'explicit-claude' } }), 'explicit-claude');
  }
});

test('Claude detection ignores broken links, directories and nonexecutable files', { skip: process.platform === 'win32' }, t => {
  const home = fixture(t), extensions = path.join(home, '.vscode', 'extensions');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(home, 'missing'), path.join(home, '.local', 'bin', 'claude'));
  for (const version of ['2.1.100', '2.1.99']) {
    const file = path.join(extensions, `anthropic.claude-code-${version}-darwin-arm64`, 'resources', 'native-binary', 'claude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (version === '2.1.100') fs.mkdirSync(file); else fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  }
  assert.throws(() => claudeBinary({ home, platform: 'darwin', arch: 'arm64', env: { PATH: '' }, files: localFiles(home) }), /Unable to find Claude Code/);
});

test('Claude sign-in delegates PKCE to the official CLI and only accepts a code on stdin', async t => {
  const root = fixture(t), child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=fixture';
  const login = startClaudeLogin({ directory: path.join(root, 'login'), binary: 'official-claude', env: { ANTHROPIC_AUTH_TOKEN: 'do-not-inherit' },
    spawnImpl: (binary, args, options) => {
      assert.equal(binary, 'official-claude'); assert.deepEqual(args, ['auth', 'login', '--claudeai']);
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined); return child;
    }, readAuth: async () => oauth });
  t.after(() => login.cancel()); child.stdout.write('Opening browser: ' + url); await login.ready;
  assert.equal(login.url, url); assert.throws(() => login.submit('a\nb'));
  let submitted = ''; child.stdin.on('data', data => { submitted += data; }); login.submit('code#state'); assert.equal(submitted, 'code#state\n');
  child.emit('close', 0); assert.equal(await login.completed, true); assert.equal(login.url, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'login', 'oauth.json'))).accessToken, oauth.accessToken);
});

test('Claude credentials support protected file storage and refresh once for parallel requests', async t => {
  const root = fixture(t), provider = { type: 'account', accountHome: root };
  atomic(path.join(root, '.credentials.json'), { claudeAiOauth: oauth });
  assert.deepEqual(await existingClaudeAuth(root, { platform: 'linux' }), oauth);
  atomic(path.join(root, 'oauth.json'), { ...oauth, expiresAt: 1 });
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, 'https://platform.claude.com/v1/oauth/token');
    assert.equal(JSON.parse(options.body).refresh_token, 'refresh-secret'); await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 });
  };
  assert.deepEqual(await Promise.all([claudeToken(provider, fetchImpl), claudeToken(provider, fetchImpl)]), ['new-token', 'new-token']); assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'oauth.json'))).refreshToken, 'new-refresh');
});

test('Claude model discovery paginates actual provider IDs and never borrows the Codex catalog', async t => {
  const root = fixture(t), provider = { type: 'api', baseUrl: 'https://example.test/anthropic/v1', apiKey: 'key' }; let calls = 0;
  const result = await discoverClaudeModels(provider, root, { fetchImpl: async (url, options) => {
    calls++; assert.equal(options.headers['x-api-key'], 'key');
    assert.equal(url, 'https://example.test/anthropic/v1/models' + (calls === 2 ? '?after_id=deepseek-flash' : ''));
    return Response.json({ data: [{ id: calls === 1 ? 'deepseek-flash' : 'claude-example' }], has_more: calls === 1, last_id: 'deepseek-flash' });
  } });
  assert.deepEqual(result.models.map(model => model.id), ['deepseek-flash', 'claude-example']);
  await assert.rejects(discoverClaudeModels(provider, root, { fetchImpl: async () => new Response('SECRET', { status: 404 }) }), /model catalog/);
});

test('one proxy isolates Codex and Claude credentials; quota failover preserves Messages tools and original fallback model', async t => {
  const root = fixture(t), claude = path.join(root, 'claude'), token = readState(claude).token;
  addProvider('codex', { type: 'api', baseUrl: 'https://codex.test/v1', apiKey: 'CODEX_SECRET' }, root);
  addProvider('relay', { type: 'api', baseUrl: 'https://relay.test/anthropic', apiKey: 'CLAUDE_API_SECRET', claudeModels: { default: 'deepseek-flash' } }, claude);
  const accountHome = path.join(claude, 'accounts', 'sub'); atomic(path.join(accountHome, 'oauth.json'), oauth);
  addProvider('sub', { type: 'account', accountHome }, claude);
  const calls = [];
  const url = await proxy(t, root, { fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) return new Response('quota exhausted', { status: 429 });
    return new Response(sse, { headers: { 'content-type': 'text/event-stream', 'anthropic-ratelimit-requests-remaining': '2' } });
  } });
  assert.equal((await request(url, readState(root).token)).status, 401);
  const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'result' }] }];
  const response = await request(url, token, { messages }, { 'x-claude-code-session-id': 'session-a', 'anthropic-beta': 'tools-2026', 'x-api-key': 'NATIVE_SECRET' });
  assert.match(await response.text(), /done/); assert.equal(response.headers.get('x-switch-alias'), 'sub');
  assert.equal(calls[0].headers['x-api-key'], 'CLAUDE_API_SECRET'); assert.equal(calls[0].url, 'https://relay.test/anthropic/v1/messages?beta=true');
  assert.equal(calls[1].headers.authorization, 'Bearer subscription-secret'); assert.equal(calls[1].headers['x-api-key'], undefined);
  assert.match(calls[1].headers['anthropic-beta'], /tools-2026,oauth-2025-04-20/);
  assert.ok(!JSON.stringify(calls).includes('CODEX_SECRET')); assert.ok(!JSON.stringify(calls).includes('NATIVE_SECRET'));
  assert.equal(JSON.parse(calls[0].body).model, 'deepseek-flash'); assert.equal(JSON.parse(calls[1].body).model, 'claude-client');
  assert.deepEqual(JSON.parse(calls[1].body).messages, messages); assert.equal(readState(root).active, 'codex'); assert.equal(readState(claude).active, 'sub');
});

test('manual Claude switching applies to the next request while accepted output is never replayed', async t => {
  const root = fixture(t), claude = path.join(root, 'claude'), token = readState(claude).token;
  for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test`, apiKey: alias }, claude);
  const calls = []; let finish;
  const url = await proxy(t, root, { fetchImpl: async (url, options) => {
    calls.push(url);
    if (calls.length > 1) return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"text":"first"}}\n\n'));
      finish = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"type":"overloaded_error"}}\n\n')); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = await request(url, token); activate('b', claude); finish(); assert.match(await response.text(), /overloaded_error/); assert.equal(calls.length, 1);
  assert.match(await (await request(url, token)).text(), /done/); assert.equal(calls[1], 'https://b.test/v1/messages?beta=true');
});
test('Claude startup SSE quota errors fail over, while concurrent queue edits cannot revive a deleted provider', async t => {
  for (const removed of [false, true]) {
    const root = fixture(t), claude = path.join(root, 'claude'), token = readState(claude).token;
    for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test`, apiKey: alias }, claude);
    let calls = 0;
    const url = await proxy(t, root, { fetchImpl: async () => {
      calls++;
      if (calls > 1) return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      if (removed) removeProvider('b', claude);
      return new Response('event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
    const response = await request(url, token);
    assert.equal(response.status, removed ? 429 : 200); await response.text(); assert.equal(calls, removed ? 1 : 2);
    assert.equal(readState(claude).active, removed ? 'a' : 'b');
  }
});
test('Claude provider-level forbidden errors try the next provider before output, while content policy remains final', async t => {
  for (const style of ['http', 'sse', 'policy']) {
    const root = fixture(t), claude = path.join(root, 'claude'), token = readState(claude).token;
    for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test`, apiKey: alias }, claude);
    const calls = [];
    const url = await proxy(t, root, { fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length > 1) return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      const error = { type: 'permission_error', message: style === 'policy' ? 'content_policy_violation' : 'Forbidden' };
      return style === 'sse' ? new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json({ error }, { status: 403 });
    } });
    const response = await request(url, token); await response.text();
    assert.equal(response.status, style === 'policy' ? 403 : 200); assert.equal(calls.length, style === 'policy' ? 1 : 2);
    if (calls.length === 2) assert.deepEqual(JSON.parse(calls[0].options.body), JSON.parse(calls[1].options.body));
  }
});

test('Claude API settings and model mappings stay separate from Codex in the desktop controller', async t => {
  const root = fixture(t), controller = new DesktopController({ root, codexHome: path.join(root, 'codex'), claudeHome: path.join(root, 'claude-home'), binary: 'unused', port: 0 });
  controller.addAPI({ alias: 'same', key: 'codex-secret' }); controller.clientSelection('claude');
  controller.addAPI({ alias: 'same', key: 'claude-secret', claudeModels: { default: 'deepseek-flash' } });
  assert.equal(controller.snapshot().providers[0].baseUrl, 'https://api.anthropic.com');
  assert.equal(controller.snapshot().providers[0].claudeModels.default, 'deepseek-flash'); assert.ok(!JSON.stringify(controller.snapshot()).includes('secret'));
  await controller.start(); assert.ok(fs.existsSync(path.join(root, 'claude-home', 'settings.json')));
  controller.clientSelection('codex'); assert.equal(controller.snapshot().providers[0].claudeModels, undefined); assert.equal(controller.snapshot().providers[0].baseUrl, 'https://api.openai.com/v1');
  await controller.stop(); assert.equal(fs.existsSync(path.join(root, 'claude-home', 'settings.json')), false);
});

test('provider mappings cover main, agent, Haiku and count-token requests without changing tools or explicit main IDs', async t => {
  const root = fixture(t), claude = path.join(root, 'claude'), token = readState(claude).token;
  addProvider('relay', { type: 'api', baseUrl: 'https://relay.test', apiKey: 'relay-key', claudeModels: { default: 'deepseek-main', subagent: 'deepseek-agent' } }, claude);
  const calls = [];
  const url = await proxy(t, root, { fetchImpl: async (url, options) => {
    calls.push({ url, headers: options.headers, payload: JSON.parse(options.body) });
    return Response.json({ id: 'msg_test', content: [] });
  } });
  const tools = [{ name: 'Agent', description: 'Delegate a task', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } }];
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: { prompt: 'Inspect files' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'Found files' }] }];
  for (const [model, agent, expected] of [['claude-sonnet-test', false, 'deepseek-main'], ['claude-opus-test', true, 'deepseek-agent'], ['claude-haiku-test', false, 'deepseek-agent'], ['another-explicit-model', false, 'another-explicit-model']]) {
    const response = await request(url, token, { model, tools, messages }, agent ? { 'x-claude-code-agent-id': 'worker-1' } : {});
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls.at(-1).payload.model, expected);
    assert.deepEqual(calls.at(-1).payload.tools, tools); assert.deepEqual(calls.at(-1).payload.messages, messages);
  }
  assert.equal(calls[1].headers['x-claude-code-agent-id'], 'worker-1');
  assert.equal(calls[0].headers.authorization, 'Bearer relay-key'); assert.equal(calls[0].headers['x-api-key'], 'relay-key');
  const count = await fetch(url + '/claude/v1/messages/count_tokens', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }) });
  assert.equal(count.status, 200); await count.text(); assert.equal(calls.at(-1).payload.model, 'deepseek-main');
  editProvider('relay', { claudeModels: null }, claude);
  await (await request(url, token, { model: 'claude-sonnet-test' })).text(); assert.equal(calls.at(-1).payload.model, 'claude-sonnet-test');
});

test('family mappings validate independently and take priority over legacy defaults and agent headers', () => {
  const mapping = { fable: 'deepseek-v4-pro', opus: 'deepseek-v4-1-flash', haiku: 'deepseek-v4-flash', sonnet: 'another-model', default: 'legacy-main', subagent: 'legacy-agent' };
  assert.deepEqual(claudeModelMapping(mapping), mapping);
  for (const [family, expected] of Object.entries(mapping).slice(0, 4)) {
    for (const id of [family, `claude-${family}-5`, `claude-${family}-5[1m]`]) {
      assert.equal(mappedClaudeModel({ type: 'api', claudeModels: mapping }, id, { 'x-claude-code-agent-id': 'fixture' }), expected);
      assert.equal(mappedClaudeModel({ type: 'account' }, id), id);
    }
  }
  assert.equal(mappedClaudeModel({ type: 'api', claudeModels: mapping }, 'deepseek-v4-flash', { 'x-claude-code-agent-id': 'fixture' }), 'deepseek-v4-flash');
  assert.throws(() => claudeModelMapping({ fable: 'invalid id' }), /Invalid Claude model mapping/);
});

test('custom Claude menu settings restore exactly after mapping switches and interrupted updates', t => {
  for (const interrupted of [false, true]) {
    const root = fixture(t), directory = path.join(root, 'settings'), file = path.join(directory, 'settings.json');
    fs.mkdirSync(directory); const original = '{"env":{"ANTHROPIC_CUSTOM_MODEL_OPTION":"user-model","CUSTOM":"yes"}}\n'; fs.writeFileSync(file, original);
    const provider = id => ({ type: 'api', claudeModels: { default: id } });
    activateClaude(root, directory, 12345, 'local-token', claudeModelEnvironment(provider('deepseek-a')));
    assert.equal(JSON.parse(fs.readFileSync(file)).env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'deepseek-a');
    assert.equal(JSON.parse(fs.readFileSync(file)).env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
    const recordFile = path.join(root, 'claude-session.json');
    if (interrupted) {
      const record = JSON.parse(fs.readFileSync(recordFile));
      atomic(recordFile, { ...record, pendingEnv: { ...record.env, ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-b' } });
      const settings = JSON.parse(fs.readFileSync(file)); settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'deepseek-b'; atomic(file, settings);
    } else {
      activateClaude(root, directory, 12345, 'local-token', claudeModelEnvironment(provider('deepseek-b')));
      assert.equal(JSON.parse(fs.readFileSync(file)).env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'deepseek-b');
      const before = fs.readFileSync(file, 'utf8'); activateClaude(root, directory, 12345, 'local-token', claudeModelEnvironment(provider('deepseek-b')));
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      activateClaude(root, directory, 12345, 'local-token', {});
      assert.equal(JSON.parse(fs.readFileSync(file)).env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'user-model');
    }
    restoreClaude(recordFile); assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('desktop mappings reject invalid values atomically, preserve secrets and remain provider-specific', t => {
  const root = fixture(t), controller = new DesktopController({ root, codexHome: path.join(root, 'codex'), binary: 'unused' });
  controller.clientSelection('claude'); controller.addAPI({ alias: 'relay', key: 'private-key' });
  for (const claudeModels of [{ default: 'invalid id' }, { subagent: [] }, { unknown: 'model' }]) assert.throws(() => controller.edit({ original: 'relay', alias: 'relay', claudeModels }), /Invalid Claude model mapping/);
  assert.equal(readState(path.join(root, 'claude')).providers.relay.claudeModels, undefined);
  controller.edit({ original: 'relay', alias: 'renamed', claudeModels: { default: 'deepseek-main' } });
  assert.equal(controller.snapshot().providers[0].claudeModels.default, 'deepseek-main');
  assert.ok(!JSON.stringify(controller.snapshot()).includes('private-key'));
  controller.edit({ original: 'renamed', alias: 'renamed', claudeModels: {} }); assert.equal(controller.snapshot().providers[0].claudeModels, null);
});

test('Claude discovery can use a same-host OpenAI model listing without sending a generation request', async t => {
  const root = fixture(t), urls = [];
  const result = await discoverClaudeModels({ type: 'api', baseUrl: 'https://relay.test/anthropic', apiKey: 'key' }, root, { fetchImpl: async (url, options) => {
    urls.push(url); assert.equal(options.headers.authorization, 'Bearer key'); assert.equal(options.redirect, 'error');
    return url === 'https://relay.test/models' ? Response.json({ data: [{ id: 'deepseek-main' }] }) : new Response('', { status: 404 });
  } });
  assert.deepEqual(result.models.map(model => model.id), ['deepseek-main']);
  assert.deepEqual(urls, ['https://relay.test/anthropic/v1/models', 'https://relay.test/anthropic/models', 'https://relay.test/models']);
});
