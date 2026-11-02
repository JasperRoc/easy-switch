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

const binary = process.env.SWITCH_TEST_CLAUDE;
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
