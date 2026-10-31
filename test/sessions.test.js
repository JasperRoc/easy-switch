import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SessionTracker, sessionID } from '../src/sessions.js';
import { init, addProvider, setModel, readState } from '../src/store.js';
import { createProxy } from '../src/proxy.js';

test('session identity requires an explicit unambiguous client ID', () => {
  assert.equal(sessionID({ 'thread-id': 'task-a', 'session-id': 'task-a' }), 'task-a');
  assert.equal(sessionID({ 'session-id': 'legacy-task' }), 'legacy-task');
  for (const headers of [{}, { 'thread-id': '__proto__' }, { 'thread-id': 'a', 'session-id': 'b' }]) assert.equal(sessionID(headers), null);
});
test('parallel sessions keep separate models while accepted streams and tool history survive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { token } = init(root); addProvider('api', { type: 'api', baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret' }, root);
  setModel({ model: 'global-model', effort: 'low' }, root);
  const sessions = new SessionTracker(), requests = []; let finish;
  const server = createProxy({ root, sessions, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); requests.push(payload);
    if (requests.length === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"part":1}\n\n'));
      finish = () => { controller.enqueue(new TextEncoder().encode('data: {"part":2}\n\n')); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const send = (id, input = [{ role: 'user', content: 'Task ' + id }], authorization = token) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${authorization}`, ...(id ? { 'thread-id': id } : {}) }, body: JSON.stringify({ model: 'client-model', reasoning: { effort: 'medium' }, input }),
  });
  const first = await send('task-a');
  assert.equal(sessions.snapshot(readState(root))[0].activeRequests, 1);
  setModel({ model: 'task-model', effort: 'high' }, root, undefined, 'task-a');
  await (await send('task-b')).text(); assert.equal(requests.at(-1).model, 'global-model');
  const history = [{ role: 'user', content: 'Continue task a' }, { type: 'function_call_output', call_id: 'fixture', output: 'tool result' }];
  await (await send('task-a', history)).text();
  assert.equal(requests.at(-1).model, 'task-model'); assert.equal(requests.at(-1).reasoning.effort, 'high'); assert.deepEqual(requests.at(-1).input, history);
  finish(); assert.match(await first.text(), /"part":2/); assert.equal(requests[0].model, 'global-model');
  setModel(null, root, undefined, 'task-a');
  await (await send('task-a')).text(); assert.equal(requests.at(-1).model, 'client-model'); assert.equal(requests.at(-1).reasoning.effort, 'medium');
  await (await send(null)).text(); assert.equal(requests.at(-1).model, 'global-model');
  assert.equal((await send('unauthorized', undefined, 'wrong')).status, 401);
  const snapshot = sessions.snapshot(readState(root));
  assert.equal(snapshot.length, 2); assert.ok(snapshot.every(session => session.activeRequests === 0));
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8').includes('Continue task a'), false);
});
