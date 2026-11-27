import fs from 'node:fs';
import path from 'node:path';
import type { UsageRecord } from './usage-stats.js';

interface Cursor {
  size: number; mtime: number; offset: number; model: string; total: number[];
  pending?: number[]; tail: Buffer; skipping: boolean; rows: UsageRecord[];
}
const cache = new Map<string, Cursor>();
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
// Read-only incremental scans. Output and encrypted message lines are discarded;
// per-file cursors are bounded and no Codex process or background timer is used.
export async function codexSessionUsage(home: string, since: number): Promise<UsageRecord[]> {
  const files: { file: string; stat: fs.Stats }[] = [];
  let visited = 0, budget = 64 * 1024 * 1024;
  function walk(directory: string) {
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > 20000) return;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = fs.statSync(file, { throwIfNoEntry: false }); if (stat?.mtimeMs >= since) files.push({ file, stat });
      }
    }
  }
  for (const folder of ['sessions', 'archived_sessions']) walk(path.join(home, folder));
  const output = new Map<string, UsageRecord>();
  const existing = new Set(files.map(item => item.file));
  for (const file of cache.keys()) if (file.startsWith(home + path.sep) && !existing.has(file)) cache.delete(file);
  for (const { file, stat } of files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 256)) {
    let saved = cache.get(file);
    if (!saved || stat.size < saved.size || stat.size === saved.size && stat.mtimeMs !== saved.mtime)
      saved = { size: 0, mtime: 0, offset: 0, model: '', total: [], tail: Buffer.alloc(0), skipping: false, rows: [] };
    saved.rows = saved.rows.filter(row => row.at >= Date.now() - 31 * 86400000);
    const parse = (line: Buffer) => {
      if (!/"(?:token_count|token_usage_record|turn_context)"/.test(line.toString())) return;
      let row; try { row = JSON.parse(line.toString()); } catch { return; }
      const p = row.payload || {};
      if (row.type === 'turn_context') { if (typeof p.model === 'string') saved.model = p.model; return; }
      const usage = row.type === 'token_usage_record' ? p.usage : p.type === 'token_count' ? p.info?.last_token_usage : null;
      const cumulative = p.info?.total_token_usage;
      const signature = (value: any) => [count(value?.input_tokens), count(value?.output_tokens), count(value?.cached_input_tokens), count(value?.cache_write_input_tokens)];
      let values = signature(usage);
      const total = signature(cumulative);
      if (p.type === 'token_count' && saved.pending) {
        saved.pending = undefined;
        if (cumulative) saved.total = total;
        // The adjacent legacy snapshot describes the modern response record,
        // including versions that account for reasoning output differently.
        return;
      } else if (cumulative) {
        if (saved.total.length && total.every((value, i) => value === saved.total[i])) return;
        if (!usage) values = saved.total.length ? total.map((value, i) => Math.max(0, value - saved.total[i])) : [0, 0, 0, 0];
        saved.total = total;
      }
      if (!usage && !cumulative || !(values[0] || values[1])) return;
      if (row.type === 'token_usage_record') saved.pending = values;
      values[2] = Math.min(values[2], values[0]); values[3] = Math.min(values[3], values[0] - values[2]);
      const at = Date.parse(row.timestamp); if (!Number.isFinite(at)) return;
      saved.rows.push({ schema: 2, at, client: 'codex', provider: '', model: saved.model, account: false, source: 'session', responseId: typeof p.response_id === 'string' ? p.response_id : undefined,
        status: 0, outcome: 'success', durationMs: 0, input: values[0], output: values[1], cached: values[2], cacheWrite: values[3] });
      if (saved.rows.length > 10000) saved.rows.shift();
    };
    if (stat.size > saved.offset && budget > 0) {
      const end = Math.min(stat.size, saved.offset + 8 * 1024 * 1024, saved.offset + budget);
      const stream = fs.createReadStream(file, { start: saved.offset, end: end - 1 });
      try { for await (const chunk of stream) {
        saved.offset += chunk.length; budget -= chunk.length;
        let start = 0, newline: number;
        while ((newline = chunk.indexOf(10, start)) !== -1) {
          if (!saved.skipping && saved.tail.length + newline - start <= 32768) parse(Buffer.concat([saved.tail, chunk.subarray(start, newline)]));
          saved.tail = Buffer.alloc(0); saved.skipping = false; start = newline + 1;
        }
        if (!saved.skipping) {
          if (saved.tail.length + chunk.length - start <= 32768) saved.tail = Buffer.concat([saved.tail, chunk.subarray(start)]);
          else { saved.tail = Buffer.alloc(0); saved.skipping = true; }
        }
      } } finally { stream.destroy(); }
      saved.size = stat.size; saved.mtime = stat.mtimeMs; cache.set(file, saved);
      while (cache.size > 256 || [...cache.values()].reduce((total, item) => total + item.rows.length, 0) > 100000) cache.delete(cache.keys().next().value);
    }
    for (const row of saved.rows) if (row.at >= since) output.set(row.responseId || `${file}:${row.at}:${row.input}:${row.output}`, row);
    if (output.size >= 100000) break;
  }
  return [...output.values()].slice(0, 100000);
}
