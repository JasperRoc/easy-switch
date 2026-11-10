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

test('official Claude client keeps one Desktop conversation and gateway identity across three models and Flash failover', { skip: !binary, timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-claude-union-client-')), directory = path.join(root, 'config');
  const claude = path.join(root, 'claude'); init(root); const { token } = init(claude);
  const ids = ['deepseek-v4-pro', 'deepseek-v4-1-flash', 'deepseek-v4-flash'];
  for (const alias of ['first', 'second']) addProvider(alias, { type: 'api', baseUrl: `https://${alias}.test`, apiKey: `${alias}-key`, claudeModels: { default: ids[0] } }, claude);
  const calls = [];
  const server = createProxy({ root, fetchImpl: async (url, options) => {
    if (!options.body) return Response.json({ data: ids.map(id => ({ id })) });
    const payload = JSON.parse(options.body), alias = new URL(url).hostname.split('.')[0];
    calls.push({ alias, payload, target: new URL(url).pathname });
    if (alias === 'first' && payload.model === ids[2] && payload.stream) return Response.json({ error: { type: 'rate_limit_error', message: 'Flash channel busy' } }, { status: 429 });
    if (!payload.stream) return Response.json({ id: 'msg_check', type: 'message', role: 'assistant', model: payload.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    const events = [
      { type: 'message_start', message: { id: 'msg_' + calls.length, type: 'message', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'UNION_OK ' + payload.model } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/claude-desktop`, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } }));
  const settings = fs.readFileSync(path.join(directory, 'settings.json'), 'utf8');
  const catalog = await (await fetch(`http://127.0.0.1:${server.address().port}/claude-desktop/v1/models`, { headers: { authorization: `Bearer ${token}` } })).json();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SUBAGENT_MODEL|CUSTOM_HEADERS))/.test(key)) delete env[key];
  const child = spawn(binary, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', catalog.data[0].id, '--tools', '', '--setting-sources', 'user'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stderr.resume(); child.stdout.on('data', data => { output += data; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const records = output.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      if (predicate(records)) return records;
      if (child.exitCode !== null) throw new Error('Client exited: ' + output.slice(-1500));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Client did not complete: ' + output.slice(-1500));
  }
  for (let index = 0; index < ids.length; index++) {
    if (index) {
      send({ type: 'control_request', request_id: `model-${index}`, request: { subtype: 'set_model', model: catalog.data[index].id } });
      const records = await waitFor(records => records.some(record => record.type === 'control_response' && record.response?.request_id === `model-${index}`));
      const control = records.find(record => record.type === 'control_response' && record.response?.request_id === `model-${index}`);
      assert.equal(control.response.subtype, 'success', JSON.stringify(control));
    }
    send({ type: 'user', message: { role: 'user', content: `Turn ${index + 1}: reply OK.` } });
    const records = await waitFor(records => records.filter(record => record.type === 'result').length >= index + 1);
    const result = records.filter(record => record.type === 'result').at(-1);
    assert.equal(result.is_error, false, JSON.stringify(result));
  }
  const turns = calls.filter(call => call.target.endsWith('/messages') && JSON.stringify(call.payload.messages).includes('Turn '));
  assert.deepEqual(turns.map(call => [call.alias, call.payload.model]), [['first', ids[0]], ['first', ids[1]], ['first', ids[2]], ['second', ids[2]]]);
  assert.deepEqual(turns.at(-2).payload.messages, turns.at(-1).payload.messages);
  for (const text of ['Turn 1', 'Turn 2', 'Turn 3']) assert.match(JSON.stringify(turns.at(-1).payload.messages), new RegExp(text));
  const results = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(record => record.type === 'result');
  assert.equal(new Set(results.map(record => record.session_id)).size, 1);
  const exited = once(child, 'exit'); child.stdin.end(); await exited;
  activate('first', claude);
  const resumed = spawn(binary, ['--print', '--verbose', '--output-format', 'stream-json', '--resume', results[0].session_id, '--model', catalog.data[2].id, '--tools', '', '--setting-sources', 'user', 'Turn 4: resume this conversation.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let resumedOutput = ''; resumed.stdout.on('data', data => { resumedOutput += data; }); resumed.stderr.resume();
  t.after(() => { if (resumed.exitCode === null) resumed.kill('SIGKILL'); });
  const [code] = await once(resumed, 'exit'); assert.equal(code, 0, resumedOutput.slice(-1500));
  const result = resumedOutput.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(record => record.type === 'result');
  assert.equal(result.is_error, false, JSON.stringify(result)); assert.equal(result.session_id, results[0].session_id);
  const continuation = calls.findLast(call => JSON.stringify(call.payload.messages).includes('Turn 4'));
  assert.equal(continuation.alias, 'second'); assert.equal(continuation.payload.model, ids[2]);
  for (const text of ['Turn 1', 'Turn 2', 'Turn 3', 'Turn 4']) assert.match(JSON.stringify(continuation.payload.messages), new RegExp(text));
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), settings);
});
