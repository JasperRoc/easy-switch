import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { addProvider, init, activate } from '../src/store.js';
import { createProxy } from '../src/proxy.js';
import { activateClaude, restoreClaude } from '../src/claude-config.js';
import { claudeModelEnvironment } from '../src/claude-models.js';
import { claudeDesktopModels } from '../src/claude-desktop.js';

const binary = process.env.SWITCH_TEST_CLAUDE;
test('official Claude Code preserves three distinct Desktop model selections with context markers and saved defaults', { skip: !binary, timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-desktop-client-models-')), directory = path.join(root, 'config');
  const claude = path.join(root, 'claude'); init(root); const { token } = init(claude);
  const ids = ['deepseek-v4-pro', 'deepseek-v4-1-flash', 'deepseek-v4-flash'], models = ids.map(id => ({ id, label: id }));
  const provider = { type: 'api', baseUrl: 'https://relay.test', apiKey: 'fixture-key', claudeModels: { default: ids[0], subagent: ids[0] } };
  addProvider('relay', provider, claude); const calls = [];
  const server = createProxy({ root, fetchImpl: async (_url, options) => {
    if (!options.body) return Response.json({ data: ids.map(id => ({ id })) });
    const payload = JSON.parse(options.body); calls.push(payload.model);
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MODEL_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/claude-desktop`, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SUBAGENT_MODEL|CUSTOM_HEADERS))/.test(key)) delete env[key];
  const catalog = claudeDesktopModels(provider, 'relay', models);
  for (let index = 0; index < ids.length; index++) for (const suffix of ['', '[1m]']) {
    const before = calls.length;
    const child = spawn(binary, ['--print', '--verbose', '--output-format', 'stream-json', '--model', catalog.data[index].id + suffix, '--tools', '', '--no-session-persistence', '--setting-sources', 'user', 'Reply MODEL_OK.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, output.slice(-1000));
    assert.match(output, /MODEL_OK/); assert.ok(calls.length > before);
    assert.ok(calls.slice(before).includes(ids[index]), JSON.stringify({ selected: catalog.data[index].id + suffix, calls: calls.slice(before) }));
    assert.ok(calls.slice(before).every(model => model === ids[index]), 'no request may silently use the saved default');
  }
});
test('official Claude Code reads user routing settings and continues the same conversation on another API', { skip: !binary, timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-real-claude-')), directory = path.join(root, 'config');
  const claude = path.join(root, 'claude'); init(root); const state = init(claude);
  for (const alias of ['first', 'second']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test`, apiKey: `${alias}-secret` }, claude);
  const calls = [];
  const server = createProxy({ root, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    const payload = JSON.parse(options.body); calls.push({ url, payload, headers: options.headers });
    // A terminal assistant response, without requesting any tools or external data.
    return new Response([
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  activateClaude(root, directory, server.address().port, state.token);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_CUSTOM_HEADERS']) delete env[key];
  const child = spawn(binary, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'claude-fixture', '--tools', '', '--no-session-persistence', '--setting-sources', 'user'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stderr.resume(); child.stdout.on('data', data => { output += data; });
  t.after(() => { child.kill('SIGKILL'); restoreClaude(path.join(root, 'claude-session.json')); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = text => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  const waitResult = async count => {
    for (let tries = 0; tries < 600; tries++) {
      if ((output.match(/"type":"result"/g) || []).length >= count) return;
      if (child.exitCode !== null) throw new Error('Claude Code exited before returning a result: ' + output.slice(-1500));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Claude Code did not complete the local mock request: ' + output.slice(-1500));
  };
  send('Reply locally.'); await waitResult(1); activate('second', claude); send('Continue this same conversation.'); await waitResult(2);
  assert.ok(calls.some(call => call.url.startsWith('https://first.test/v1/messages')));
  const last = calls.findLast(call => call.url.startsWith('https://second.test/v1/messages')); assert.ok(last);
  assert.equal(last.headers['x-api-key'], 'second-secret'); assert.match(JSON.stringify(last.payload.messages), /Reply locally/);
  assert.match(JSON.stringify(last.payload.messages), /Continue this same conversation/); assert.match(output, /LOCAL_OK/);
});

test('official Claude Code executes an Agent tool through separate main and subagent API mappings', { skip: !binary, timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-real-agent-')), directory = path.join(root, 'config');
  const claude = path.join(root, 'claude'); init(root); const state = init(claude);
  const provider = { type: 'api', baseUrl: 'https://agent.test', apiKey: 'fixture-agent-key', claudeModels: { default: 'deepseek-main', subagent: 'deepseek-worker' } };
  addProvider('relay', provider, claude);
  const calls = []; let issued = false;
  const server = createProxy({ root, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [] });
    const payload = JSON.parse(options.body); calls.push({ payload, headers: options.headers });
    const agent = payload.model === 'deepseek-worker';
    const tool = payload.tools?.find(tool => ['Agent', 'Task'].includes(tool.name));
    const block = !agent && !issued && tool ? { type: 'tool_use', id: 'toolu_local_agent', name: tool.name,
      input: { description: 'Verify local fixture', prompt: 'Reply CHILD_OK without tools.', subagent_type: 'local-verifier', model: 'haiku' } }
      : { type: 'text', text: agent ? 'CHILD_OK' : 'AGENT_OK' };
    if (block.type === 'tool_use') issued = true;
    const events = [
      { type: 'message_start', message: { id: 'msg_' + calls.length, type: 'message', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  activateClaude(root, directory, server.address().port, state.token, claudeModelEnvironment(provider));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SUBAGENT_MODEL|CUSTOM_HEADERS))/.test(key)) delete env[key];
  const child = spawn(binary, ['--print', '--verbose', '--output-format', 'stream-json', '--model', 'claude-fixture', '--tools', 'Agent', '--allowedTools', 'Agent',
    '--agents', JSON.stringify({ 'local-verifier': { description: 'Verifies the local fixture', prompt: 'Return CHILD_OK without tools.', model: 'haiku', tools: [] } }),
    '--no-session-persistence', '--setting-sources', 'user', 'Delegate to local-verifier and report its response.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); restoreClaude(path.join(root, 'claude-session.json')); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output.slice(-2000) + error.slice(-1000));
  assert.ok(issued, 'the official client must expose and execute the Agent tool');
  assert.ok(calls.some(call => call.payload.model === 'deepseek-worker'), 'the child request uses the provider subagent mapping: ' + output.slice(-2000));
  const continuation = calls.findLast(call => call.payload.model === 'deepseek-main');
  assert.match(JSON.stringify(continuation.payload.messages), /CHILD_OK/);
  assert.ok(calls.every(call => call.headers['x-api-key'] === provider.apiKey));
  assert.match(output, /AGENT_OK/);
});
