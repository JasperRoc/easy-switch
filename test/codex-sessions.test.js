import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexSessions } from '../desktop/codex-sessions.js';
import { codexThread } from './fixtures/codex-metadata.js';

const payload = { model: 'client-model', input: '<codex_internal_context>Internal request</codex_internal_context>' };
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-task-metadata-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, sessions: new CodexSessions(home) };
}

test('uses the Codex sidebar name, one entry per real user task, and excludes helpers and archived tasks', t => {
  const { home, sessions } = setup(t);
  const user = codexThread(home, 'user-task', '修复搜索功能');
  const child = codexThread(home, 'child-task', 'Internal worker', { threadSource: 'subagent' });
  const archived = codexThread(home, 'archived-task', 'Old task', { archived: 1 });
  const requests = [user, child, archived, { headers: { 'thread-id': 'ephemeral-helper' } }].map(thread => sessions.begin(thread.headers, payload));
  const parallel = sessions.begin(user.headers, payload);
  assert.deepEqual(sessions.snapshot({}).map(session => [session.id, session.title, session.activeRequests]), [['user-task', '修复搜索功能', 2]]);
  assert.equal(JSON.stringify(sessions.snapshot({})).includes('Internal request'), false);
  parallel.finish(); requests.forEach(request => request.finish());
  assert.equal(sessions.snapshot({}).length, 1, 'tool execution gaps keep the current turn visible');
  assert.equal(sessions.entries.size, 1, 'completed helper records are removed from memory');
  user.event('task_complete');
  assert.deepEqual(sessions.snapshot({}), []); assert.equal(sessions.entries.size, 0);
});

test('completion, cancellation and a new turn have separate lifecycles; model overrides survive completion', t => {
  const { home, sessions } = setup(t), thread = codexThread(home, 'task-a', 'Task A');
  const state = { sessionModels: { 'task-a': { model: 'selected', effort: 'high' } } };
  const request = sessions.begin(thread.headers, payload); request.finish();
  assert.equal(sessions.snapshot(state)[0].selection.model, 'selected');
  thread.event('turn_aborted'); assert.deepEqual(sessions.snapshot(state), []);
  const headers = { 'thread-id': 'task-a', 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'task-a', turn_id: 'next-turn', request_kind: 'turn' }) };
  const next = sessions.begin(headers, payload);
  assert.equal(sessions.snapshot(state)[0].title, 'Task A', 'previous cancellation cannot hide the next request');
  thread.event('task_started', 'next-turn'); next.finish();
  assert.equal(sessions.snapshot(state)[0].selection.model, 'selected');
  thread.event('task_complete', 'turn-task-a');
  assert.equal(sessions.snapshot(state).length, 1, 'late completion from another turn is ignored');
  thread.event('task_complete', 'next-turn'); assert.deepEqual(sessions.snapshot(state), []);
});

test('reads renamed sidebar names and falls back to the session index on older Codex schemas', t => {
  const { home, sessions } = setup(t), thread = codexThread(home, 'task-a', 'Original name');
  sessions.begin(thread.headers, payload);
  assert.equal(sessions.snapshot({})[0].title, 'Original name');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET name = ? WHERE id = ?').run('Renamed in Codex', 'task-a'); db.close();
  assert.equal(sessions.snapshot({})[0].title, 'Renamed in Codex');
  const legacy = codexThread(home, 'task-b', null);
  const oldDB = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  oldDB.exec('ALTER TABLE threads DROP COLUMN name'); oldDB.close();
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: 'task-b', thread_name: 'Indexed sidebar name' }) + '\n');
  sessions.begin(legacy.headers, payload);
  assert.equal(sessions.snapshot({}).find(session => session.id === 'task-b').title, 'Indexed sidebar name');
});

test('handles partial, large and replaced rollout records without retaining finished tasks', t => {
  const { home, sessions } = setup(t), thread = codexThread(home, 'task-a', 'Task A');
  const request = sessions.begin(thread.headers, payload); request.finish();
  assert.equal(sessions.snapshot({}).length, 1);
  fs.appendFileSync(thread.file, '{"type":"event_msg",');
  assert.equal(sessions.snapshot({}).length, 1);
  fs.appendFileSync(thread.file, '"payload":{"type":"task_complete","turn_id":"turn-task-a"}}\n');
  assert.deepEqual(sessions.snapshot({}), []);
  sessions.begin(thread.headers, payload).finish();
  fs.writeFileSync(thread.file, JSON.stringify({ type: 'response_item', payload: 'x'.repeat(2 * 1024 * 1024) }) + '\n');
  thread.event('task_complete'); assert.deepEqual(sessions.snapshot({}), []);
  sessions.begin(thread.headers, payload).finish();
  fs.writeFileSync(thread.file, ''); thread.event('task_started'); assert.equal(sessions.snapshot({}).length, 1);
  fs.renameSync(thread.file, thread.file + '.old'); thread.event('turn_aborted'); assert.deepEqual(sessions.snapshot({}), []);
});

test('missing or unreadable metadata never creates request-derived titles or persistent idle entries', t => {
  const { home, sessions } = setup(t);
  const unknown = sessions.begin({ 'thread-id': 'unknown-task' }, payload);
  assert.deepEqual(sessions.snapshot({}), []); assert.equal(sessions.unavailable, true);
  const thread = codexThread(home, 'task-a', 'Real task');
  sessions.begin(thread.headers, payload).finish(); fs.rmSync(thread.file);
  unknown.finish(); assert.deepEqual(sessions.snapshot({}), []); assert.equal(sessions.unavailable, true);
  assert.equal(sessions.entries.size, 0);
});
