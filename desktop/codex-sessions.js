import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionTracker } from '../src/sessions.js';

const tailBytes = 1024 * 1024;

// Read complete JSONL records incrementally, bounding work even for large rollouts.
function readRecords(file, cache, visit) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (cache.inode !== undefined && (cache.inode !== stat.ino || cache.device !== stat.dev || stat.size < cache.offset)) {
      for (const key of Object.keys(cache)) delete cache[key];
    }
    const offset = Math.max(cache.offset || 0, stat.size - tailBytes);
    const bytes = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, bytes, 0, bytes.length, offset);
    let start = offset > (cache.offset || 0) ? bytes.indexOf(10) + 1 : 0;
    if (start === 0 && offset > (cache.offset || 0)) start = bytes.length;
    let end;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      try { visit(JSON.parse(bytes.toString('utf8', start, end))); } catch {}
      start = end + 1;
    }
    Object.assign(cache, { inode: stat.ino, device: stat.dev, offset: offset + start });
  } finally { fs.closeSync(fd); }
}

function lifecycle(file, cache) {
  readRecords(file, cache, record => {
    if (record.type !== 'event_msg') return;
    const event = record.payload;
    if (event?.type === 'task_started') {
      Object.assign(cache, { turnId: event.turn_id, startedAt: Date.parse(record.timestamp), running: true });
    } else if (['task_complete', 'turn_aborted'].includes(event?.type) && (!event.turn_id || !cache.turnId || event.turn_id === cache.turnId)) {
      Object.assign(cache, { turnId: event.turn_id || cache.turnId, endedAt: Date.parse(record.timestamp), running: false });
    }
  });
  return cache;
}

export class CodexSessions extends SessionTracker {
  constructor(codexHome) {
    super(); this.codexHome = codexHome; this.rollouts = new Map(); this.index = {}; this.names = new Map(); this.unavailable = false;
  }
  threads() {
    const files = fs.readdirSync(this.codexHome).filter(file => /^state_\d+\.sqlite$/.test(file))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!files.length) throw new Error('Codex task metadata is not available.');
    const db = new DatabaseSync(path.join(this.codexHome, files[0]), { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      const fields = ['id', 'name', 'title', 'rollout_path', 'archived', 'thread_source', 'source', 'agent_path'].filter(field => columns.has(field));
      const query = db.prepare(`SELECT ${fields.join(', ')} FROM threads WHERE id = ?`);
      return new Map([...this.entries.keys()].map(id => [id, query.get(id)]));
    } finally { db.close(); }
  }
  snapshot(state) {
    this.unavailable = false;
    if (!this.entries.size) return [];
    let threads;
    try { threads = this.threads(); }
    catch { this.unavailable = true; return []; }
    const ids = [...this.entries.keys()].join(',');
    if (this.index.ids !== ids) this.index = {};
    try {
      readRecords(path.join(this.codexHome, 'session_index.jsonl'), this.index, record => {
        if (this.entries.has(record.id) && record.thread_name) this.names.set(record.id, record.thread_name);
      });
      this.index.ids = ids;
    } catch {} // Older CLI installations may only store titles in SQLite.
    const sessions = [];
    for (const entry of super.snapshot(state)) {
      const thread = threads.get(entry.id);
      let visible = false;
      if (thread && !thread.archived && (!thread.thread_source || thread.thread_source === 'user') && !thread.agent_path && !thread.source?.includes('subagent')) {
        visible = entry.activeRequests > 0;
        try {
          const file = thread.rollout_path;
          let cache = this.rollouts.get(entry.id);
          if (!cache || cache.file !== file) { cache = { file }; this.rollouts.set(entry.id, cache); }
          const turn = lifecycle(file, cache);
          cache.file = file;
          // A previous turn's completion cannot hide a newly started request.
          if (entry.turnId ? turn.turnId === entry.turnId : turn.running ? turn.startedAt >= entry.firstSeen - 2000 : turn.endedAt >= entry.requestStartedAt) {
            visible = turn.running;
          }
        } catch { this.unavailable = true; } // Never keep an idle entry without lifecycle evidence.
        if (visible) sessions.push({ ...entry, title: thread.name || this.names.get(entry.id) || thread.title || '' });
      }
      if (!visible && !entry.activeRequests) {
        this.entries.delete(entry.id); this.rollouts.delete(entry.id); this.names.delete(entry.id);
      }
    }
    return sessions;
  }
}
