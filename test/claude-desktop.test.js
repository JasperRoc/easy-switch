import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { activateClaudeDesktop, restoreClaudeDesktop, claudeDesktopPaths } from '../src/claude-desktop.js';
import { init, atomic, addProvider, editProvider, activate, readState } from '../src/store.js';
import { DesktopController } from '../desktop/controller.js';
import { createProxy } from '../src/proxy.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-claude-desktop-'));
  const root = path.join(directory, 'switch'), paths = claudeDesktopPaths({ env: { SWITCH_CLAUDE_DESKTOP_HOME: directory } });
  init(root); fs.mkdirSync(paths.normal);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, root, paths, record: path.join(root, 'claude-desktop-session.json') };
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('Desktop paths cover macOS, Windows variants, Linux and isolated test profiles', t => {
  const { directory } = fixture(t);
  assert.equal(claudeDesktopPaths({ platform: 'darwin', home: '/users/person', env: {} }).normal, '/users/person/Library/Application Support/Claude');
  assert.equal(claudeDesktopPaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom' } }).thirdParty, '/custom/Claude-3p');
  fs.mkdirSync(path.join(directory, 'Claude Preview')); fs.mkdirSync(path.join(directory, 'Claude-3p Preview'));
  assert.equal(claudeDesktopPaths({ platform: 'win32', env: { LOCALAPPDATA: directory } }).thirdParty, path.join(directory, 'Claude-3p Preview'));
  assert.equal(claudeDesktopPaths({ platform: 'win32', env: { LOCALAPPDATA: directory } }).normal, path.join(directory, 'Claude'));
});

test('Desktop activation preserves existing profiles and restores their exact original files', t => {
  const { root, paths, record } = fixture(t), library = path.join(paths.thirdParty, 'configLibrary');
  const normal = path.join(paths.normal, 'claude_desktop_config.json'), meta = path.join(library, '_meta.json');
  const original = '{"mcpServers":{"local":{"command":"example"}},"deploymentMode":"1p"}\n';
  const originalMeta = '{"entries":[{"id":"user-profile","name":"User"}],"appliedId":"user-profile","other":true}\n';
  fs.writeFileSync(normal, original); atomic(meta, {}); fs.writeFileSync(meta, originalMeta);
  activateClaudeDesktop(root, paths, 12345, 'local-secret');
  const applied = json(meta), profile = path.join(library, `${applied.appliedId}.json`);
  assert.equal(applied.entries.length, 2); assert.deepEqual(applied.entries[0], { id: 'user-profile', name: 'User' });
  assert.equal(json(normal).deploymentMode, '3p'); assert.deepEqual(json(normal).mcpServers, JSON.parse(original).mcpServers);
  assert.equal(json(profile).inferenceGatewayBaseUrl, 'http://127.0.0.1:12345/claude-desktop');
  assert.equal(json(profile).inferenceGatewayApiKey, 'local-secret'); assert.equal(json(profile).inferenceGatewayAuthScheme, 'bearer');
  assert.equal(json(profile).inferenceModels, undefined, 'the startup profile must not override discovered model names');
  assert.equal(json(profile).modelDiscoveryEnabled, true);
  assert.equal(json(profile).coworkEgressAllowedHosts, undefined, 'do not broaden network permissions');
  const saved = fs.readFileSync(profile, 'utf8'); activateClaudeDesktop(root, paths, 999, 'replacement');
  assert.equal(fs.readFileSync(profile, 'utf8'), saved, 'provider switches cannot rewrite the startup profile');
  assert.equal(restoreClaudeDesktop(record), true); assert.equal(restoreClaudeDesktop(record), false);
  assert.equal(fs.readFileSync(normal, 'utf8'), original); assert.equal(fs.readFileSync(meta, 'utf8'), originalMeta);
  assert.equal(fs.existsSync(profile), false); assert.equal(fs.existsSync(path.join(paths.thirdParty, 'claude_desktop_config.json')), false);
});

test('Desktop restoration retains concurrent edits and another tool’s newly selected profile', t => {
  const { root, paths, record } = fixture(t), library = path.join(paths.thirdParty, 'configLibrary');
  activateClaudeDesktop(root, paths, 12345, 'local-token');
  const normal = path.join(paths.normal, 'claude_desktop_config.json'), meta = path.join(library, '_meta.json');
  atomic(normal, { ...json(normal), mcpServers: { added: { command: 'local' } } });
  atomic(meta, { ...json(meta), entries: [...json(meta).entries, { id: 'other', name: 'Other' }], appliedId: 'other' });
  restoreClaudeDesktop(record);
  assert.deepEqual(json(normal), { mcpServers: { added: { command: 'local' } } });
  assert.deepEqual(json(meta), { entries: [{ id: 'other', name: 'Other' }], appliedId: 'other' });
});

test('invalid Desktop settings are rejected before any config is changed, and recovery records survive conflicts', t => {
  const { root, paths, record } = fixture(t), normal = path.join(paths.normal, 'claude_desktop_config.json');
  const meta = path.join(paths.thirdParty, 'configLibrary', '_meta.json');
  fs.writeFileSync(normal, '{"deploymentMode":"1p"}'); atomic(meta, { entries: 'invalid' });
  assert.throws(() => activateClaudeDesktop(root, paths, 1, 'token'), /profile list/);
  assert.equal(json(normal).deploymentMode, '1p'); assert.equal(fs.existsSync(record), false);
  atomic(meta, {}); activateClaudeDesktop(root, paths, 1, 'token'); fs.writeFileSync(normal, 'broken json');
  assert.throws(() => restoreClaudeDesktop(record)); assert.equal(fs.existsSync(record), true);
  atomic(normal, { deploymentMode: '3p' }); restoreClaudeDesktop(record); assert.equal(json(normal).deploymentMode, '1p');
});

test('partial Desktop activation restores written files without creating untouched or concurrently deleted files', t => {
  const { root, paths, record } = fixture(t);
  const normal = path.join(paths.normal, 'claude_desktop_config.json'); fs.writeFileSync(normal, '\uFEFF{"deploymentMode":"1p"}');
  activateClaudeDesktop(root, paths, 12345, 'token');
  const saved = json(record);
  for (const entry of saved.files) fs.rmSync(entry.file, { force: true });
  restoreClaudeDesktop(record);
  for (const entry of saved.files) assert.equal(fs.existsSync(entry.file), false);
});

test('CLI and Desktop share providers and failover while Desktop displays actual mapped models', async t => {
  const { root } = fixture(t), claude = path.join(root, 'claude'), { token } = init(claude), calls = [];
  for (const alias of ['a', 'b']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test/anthropic`, apiKey: `${alias}-secret`, claudeModels: { default: `${alias}-main`, subagent: `${alias}-agent` } }, claude);
  let quota = false;
  const server = createProxy({ root, fetchImpl: async (url, options) => {
    if (!options.body) return Response.json({ data: [] });
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    if (quota && options.headers['x-api-key'] === 'a-secret') return Response.json({ error: { type: 'rate_limit_error' } }, { status: 429 });
    return Response.json({ type: 'message', content: [{ type: 'text', text: 'ok' }] });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = async credential => fetch(base + '/claude-desktop/v1/models', { headers: { authorization: `Bearer ${credential}` } });
  assert.equal((await catalog(readState(root).token)).status, 401);
  let models = await (await catalog(token)).json(); assert.equal(calls.length, 0);
  assert.deepEqual(models.data.map(item => item.display_name), ['a-main', 'a-agent', 'b-main', 'b-agent']); assert.match(models.data[0].description, /^easy-switch · a-main$/);
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'local' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file result' }] }];
  const tools = [{ name: 'Read', input_schema: { type: 'object', properties: {} } }];
  const request = async (prefix, model) => {
    const response = await fetch(base + prefix + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages, tools }) });
    await response.text(); return response;
  };
  assert.equal((await request('/claude-desktop', 'claude-sonnet-5')).status, 200);
  assert.equal(calls.at(-1).body.model, 'a-main'); activate('b', claude);
  await request('/claude-desktop', 'claude-haiku-4-5-20251001'); assert.equal(calls.at(-1).body.model, 'b-agent');
  assert.deepEqual(calls.at(-1).body.messages, messages); assert.deepEqual(calls.at(-1).body.tools, tools);
  await request('/claude', 'claude-sonnet-5'); assert.equal(calls.at(-1).body.model, 'b-main');
  models = await (await catalog(token)).json(); assert.match(models.data[0].description, /a-main/);
  activate('a', claude); quota = true;
  editProvider('b', { claudeModels: { default: 'a-main', subagent: 'b-agent' } }, claude);
  const response = await request('/claude-desktop', 'claude-sonnet-5');
  assert.equal(response.headers.get('x-switch-alias'), 'b'); assert.equal(readState(claude).active, 'b');
  assert.deepEqual(calls.at(-1).body.messages, messages); assert.ok(!JSON.stringify(calls).includes(token));
});

test('Desktop discovers non-Claude models and maps health checks, chat, tools and helper requests without manual setup', async t => {
  const { root } = fixture(t), claude = path.join(root, 'claude'), { token } = init(claude), calls = [];
  addProvider('deepseek', { type: 'api', baseUrl: 'https://deepseek.test', apiKey: 'upstream-secret' }, claude);
  let discoveries = 0;
  const server = createProxy({ root, fetchImpl: async (_url, options) => {
    if (!options.body) {
      discoveries++; return Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' }] });
    }
    const payload = JSON.parse(options.body); calls.push(payload);
    if (!payload.model.startsWith('deepseek-')) return Response.json({ error: { message: '模型无可用渠道' } }, { status: 503 });
    return Response.json({ type: 'message', content: [{ type: 'text', text: 'ok' }], model: payload.model });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/claude-desktop`;
  const headers = { authorization: `Bearer ${token}` };
  const catalog = await (await fetch(base + '/v1/models', { headers })).json();
  assert.deepEqual(catalog.data.map(item => item.display_name), ['deepseek-v4-pro', 'DeepSeek V4 Flash']);
  assert.ok(catalog.data.every(item => item.id.startsWith('claude-'))); assert.equal(discoveries, 1);
  const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file content' }] }];
  const tools = [{ name: 'Read', input_schema: { type: 'object', properties: {} } }];
  for (const [model, expected] of [[catalog.data[0].id, 'deepseek-v4-pro'], [catalog.data[1].id, 'deepseek-v4-flash'], ['claude-haiku-4-5', 'deepseek-v4-pro']]) {
    const response = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model, messages, tools, max_tokens: 1 }) });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls.at(-1).model, expected); assert.deepEqual(calls.at(-1).messages, messages); assert.deepEqual(calls.at(-1).tools, tools);
  }
  assert.equal(discoveries, 1, 'catalogs are loaded on demand and cached; no request polling');
  assert.equal(readState(claude).providers.deepseek.claudeModels, undefined, 'automatic routing never overwrites saved preferences');
});

test('Desktop keeps a chat’s selected model across provider switches and invalidates edited catalogs', async t => {
  const { root } = fixture(t), claude = path.join(root, 'claude'), { token } = init(claude), calls = [];
  for (const alias of ['first', 'second']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test`, apiKey: alias + '-secret' }, claude);
  const server = createProxy({ root, fetchImpl: async (url, options) => {
    if (!options.body) return Response.json({ data: [{ id: url.includes('first.test') ? 'deepseek-pro' : url.includes('new.test') ? 'edited-model' : 'other-model' }] });
    calls.push(JSON.parse(options.body)); return Response.json({ type: 'message', content: [] });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/claude-desktop`, headers = { authorization: `Bearer ${token}` };
  const catalog = await (await fetch(base + '/v1/models', { headers })).json();
  activate('second', claude);
  const response = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: catalog.data[0].id, messages: [] }) });
  assert.equal(response.status, 200); await response.text(); assert.equal(calls.at(-1).model, 'deepseek-pro');
  assert.equal(response.headers.get('x-switch-alias'), 'first');
  editProvider('second', { baseUrl: 'https://new.test' }, claude);
  const refreshed = await (await fetch(base + '/v1/models', { headers })).json();
  assert.deepEqual(refreshed.data.map(item => item.display_name), ['deepseek-pro', 'edited-model']);
});

test('Desktop preserves every explicit model with context suffixes and agent headers despite main mappings', async t => {
  const { root } = fixture(t), claude = path.join(root, 'claude'), { token } = init(claude), calls = [];
  const ids = ['deepseek-v4-pro', 'deepseek-v4-1-flash', 'deepseek-v4-flash'];
  addProvider('relay', { type: 'api', baseUrl: 'https://relay.test', apiKey: 'private-key' }, claude);
  const server = createProxy({ root, fetchImpl: async (_url, options) => {
    if (!options.body) return Response.json({ data: ids.map(id => ({ id })) });
    calls.push(JSON.parse(options.body)); return Response.json({ type: 'message', content: [], model: calls.at(-1).model });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/claude-desktop`, headers = { authorization: `Bearer ${token}` };
  const catalog = await (await fetch(base + '/v1/models', { headers })).json();
  assert.deepEqual(catalog.data.map(item => item.display_name), ids);
  assert.ok(catalog.data.every(item => /-es-[a-f0-9]{16}$/.test(item.id)), 'no model may use a published Claude ID that overrides its name');
  const messages = [{ role: 'user', content: 'Continue the task' }], tools = [{ name: 'Read', input_schema: { type: 'object', properties: {} } }];
  for (const claudeModels of [{ default: ids[0] }, { default: ids[0], subagent: ids[0] }]) {
    editProvider('relay', { claudeModels }, claude);
    for (let index = 0; index < ids.length; index++) {
      for (const suffix of ['', '[1m]']) {
        for (const agent of [false, true]) {
          const requestHeaders = agent ? { ...headers, 'x-claude-code-agent-id': 'worker' } : headers;
          for (const model of [catalog.data[index].id + suffix, ids[index] + suffix]) {
            const response = await fetch(base + '/v1/messages', { method: 'POST', headers: requestHeaders, body: JSON.stringify({ model, messages, tools }) });
            assert.equal(response.status, 200); await response.text();
            assert.equal(calls.at(-1).model, ids[index], JSON.stringify({ model, agent, claudeModels }));
            assert.deepEqual(calls.at(-1).messages, messages); assert.deepEqual(calls.at(-1).tools, tools);
          }
        }
      }
    }
  }
});

test('Desktop can use explicit mappings when discovery is unavailable and errors retain safe upstream detail', async t => {
  const { root } = fixture(t), claude = path.join(root, 'claude'), { token } = init(claude);
  addProvider('relay', { type: 'api', baseUrl: 'https://relay.test', apiKey: 'relay-private-key', claudeModels: { default: 'deepseek-v4-pro' } }, claude);
  const server = createProxy({ root, fetchImpl: async (_url, options) => !options.body ? new Response('', { status: 404 }) : Response.json({ error: { message: 'Model deepseek-v4-pro unavailable; key=relay-private-key Bearer access-secret' } }, { status: 400 }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/claude-desktop`, headers = { authorization: `Bearer ${token}` };
  const catalog = await (await fetch(base + '/v1/models', { headers })).json(); assert.equal(catalog.data[0].display_name, 'deepseek-v4-pro');
  const response = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: catalog.data[0].id, messages: [] }) });
  assert.equal(response.status, 400); const text = await response.text(); assert.match(text, /for model deepseek-v4-pro/); assert.match(text, /unavailable/);
  assert.ok(!text.includes('relay-private-key')); assert.ok(!text.includes('access-secret')); assert.ok(!text.includes(token));
});

test('runtime connects both Claude clients and restores Desktop when stopped or the final provider is removed', async t => {
  const { root, paths } = fixture(t), claudeHome = path.join(root, 'cli');
  const controller = new DesktopController({ root, codexHome: path.join(root, 'codex'), claudeHome, claudeDesktop: paths, binary: 'unused', port: 0, detectProxy: async () => ({}) });
  t.after(() => controller.stop());
  controller.clientSelection('claude'); controller.addAPI({ alias: 'relay', key: 'secret', claudeModels: { default: 'deepseek-main' } });
  await controller.start(); assert.equal(controller.snapshot().claudeDesktop, true);
  assert.equal(json(path.join(claudeHome, 'settings.json')).env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'deepseek-main');
  await controller.remove('relay'); assert.equal(controller.snapshot().claudeDesktop, false);
  assert.equal(fs.existsSync(path.join(claudeHome, 'settings.json')), false);
  controller.addAPI({ alias: 'new', key: 'secret' }); assert.equal(controller.snapshot().claudeDesktop, true);
  await controller.stop(); assert.equal(controller.snapshot().claudeDesktop, false);
});

test('the independent recovery helper restores Desktop after an application crash', { timeout: 15000 }, async t => {
  const { root, paths, record } = fixture(t), file = path.join(paths.normal, 'claude_desktop_config.json');
  const original = '{"deploymentMode":"1p","mcpServers":{}}\n'; fs.writeFileSync(file, original);
  addProvider('relay', { type: 'api', baseUrl: 'https://relay.test', apiKey: 'secret' }, path.join(root, 'claude'));
  const script = `import {DesktopRuntime} from ${JSON.stringify(new URL('../desktop/runtime.js', import.meta.url).href)}; const runtime=new DesktopRuntime(${JSON.stringify({ root, codexHome: path.join(root, 'codex'), claudeDesktop: paths, port: 0 })}); await runtime.start(); console.log('READY');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  child.stderr.resume(); await new Promise(resolve => readline.createInterface({ input: child.stdout }).on('line', line => { if (line === 'READY') resolve(); }));
  assert.equal(json(file).deploymentMode, '3p'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  for (let n = 0; n < 100 && fs.existsSync(record); n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(record), false); assert.equal(fs.readFileSync(file, 'utf8'), original);
});
