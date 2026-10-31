import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function codexThread(home, id, name, options = {}) {
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const file = path.join(home, 'sessions', id + '.jsonl');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, rollout_path TEXT, archived INTEGER, thread_source TEXT, source TEXT, agent_path TEXT)');
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, options.title || 'Original prompt, not the task name', file, options.archived || 0, options.threadSource || 'user', 'vscode', options.agentPath || null);
  } finally { db.close(); }
  if (name) fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: name }) + '\n');
  const event = (type, turnId = 'turn-' + id) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: turnId } }) + '\n');
  event('task_started');
  return { file, event, headers: { 'thread-id': id, 'x-codex-turn-metadata': JSON.stringify({ thread_id: id, turn_id: 'turn-' + id, request_kind: 'turn' }) } };
}
