import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexSessionUsage } from './session-usage.js';
import { createInterface } from 'node:readline';
import { type Client } from './store.js';
import { officialTokenCost } from './model-prices.js';

export interface UsageFilter { days?: number; client?: Client | 'all'; group?: 'requests' | 'providers' | 'models'; page?: number; offsetMinutes?: number; status?: number; source?: 'gateway' | 'session'; }
export interface UsageRecord {
  source?: 'session'; responseId?: string;
  schema?: number; at: number; client: Client; provider: string; model: string; account: boolean; image?: boolean; status: number;
  outcome: string; durationMs: number; firstTokenMs?: number; input?: number; output?: number; cached?: number; cacheWrite?: number; cacheWriteLong?: number;
}
interface Totals {
  cacheInput: number; cacheReported: number; generationMs: number; generatedOutput: number; requests: number; success: number; unknown: number; reported: number; input: number; output: number; cached: number; cacheWrite: number;
  cost: number; priced: number; firstTokenMs: number; timed: number; durationMs: number;
}
const totals = (): Totals => ({ cacheInput: 0, cacheReported: 0, generationMs: 0, generatedOutput: 0, requests: 0, success: 0, unknown: 0, reported: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, cost: 0, priced: 0, firstTokenMs: 0, timed: 0, durationMs: 0 });
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export async function usageStats(root: string, filter: UsageFilter = {}, now = Date.now()) {
  const days = [1, 7, 30].includes(filter.days) ? filter.days : 7;
  const client = ['codex', 'claude'].includes(filter.client) ? filter.client : 'all';
  const status = Number.isInteger(filter.status) && filter.status >= 100 && filter.status <= 599 ? filter.status : undefined;
  const source = filter.source === 'session' ? 'session' : 'gateway';
  const group = ['models', 'providers'].includes(filter.group) ? filter.group : 'requests';
  const page = Number.isFinite(filter.page) ? Math.min(3999, Math.max(0, Math.trunc(filter.page))) : 0;
  const offset = Math.min(840, Math.max(-840, (Number.isFinite(filter.offsetMinutes) ? Math.trunc(filter.offsetMinutes) : 0))) * 60000;
  const dateKey = (at: number) => new Date(at - offset).toISOString().slice(0, 10);
  const end = new Date(dateKey(now) + 'T00:00:00Z').getTime() + offset + 86400000;
  const start = end - days * 86400000;
  const summary = totals(), daily = new Map<string, Totals>(), groups = new Map<string, Totals & { provider?: string; model?: string; client?: string; image?: boolean }>();
  const logs: (UsageRecord & { cost: number | null; total: number | null; input: number | null })[] = [];
  for (let i = 0; i < days; i++) daily.set(dateKey(start + i * 86400000), totals());
  let truncated = false;
  const providerNames = new Set<string>(), modelNames = new Set<string>();
  const directory = path.join(root, 'usage');
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= dateKey(start - 86400000)).sort().reverse() : [];
  const add = (target: Totals, entry: UsageRecord, input: number, cost: number | null, known: boolean) => {
    target.requests++; if (entry.outcome === 'success') target.success++;
    if (entry.outcome === 'unknown') target.unknown++;
    if (known) { target.reported++; target.input += input; target.output += count(entry.output); target.cached += count(entry.cached); target.cacheWrite += count(entry.cacheWrite); }
    if (known && Number.isSafeInteger(entry.cached)) { target.cacheInput += input; target.cacheReported++; }
    if (entry.outcome === 'success' && Number.isFinite(entry.firstTokenMs) && count(entry.output)) { target.generationMs += Math.max(1, count(entry.durationMs) - count(entry.firstTokenMs)); target.generatedOutput += count(entry.output); }
    if (cost !== null) { target.priced++; target.cost += cost; }
    if (Number.isFinite(entry.firstTokenMs)) { target.firstTokenMs += count(entry.firstTokenMs); target.timed++; }
    target.durationMs += count(entry.durationMs);
  };
  async function* records(): AsyncGenerator<UsageRecord> {
    if (source === 'session') {
      if (client !== 'claude') for (const row of await codexSessionUsage(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), start)) yield row;
      return;
    }
    for (const name of files) {
      const stream = fs.createReadStream(path.join(directory, name));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try { for await (const line of lines) {
        if (line.length > 4096) continue;
        try { yield JSON.parse(line); } catch {}
      } } finally { lines.close(); stream.destroy(); }
    }
  }
  for await (let entry of records()) {
      if (!Number.isFinite(entry.at) || entry.at < start || entry.at >= end || !['codex', 'claude'].includes(entry.client) || typeof entry.provider !== 'string' || typeof entry.model !== 'string' || (client !== 'all' && entry.client !== client) || status && entry.status !== status) continue;
      providerNames.add(JSON.stringify([entry.client, entry.provider])); modelNames.add(JSON.stringify([entry.client, entry.model, !entry.model && !!entry.image]));
      // Old captures could discard oversized completion events. HTTP 2xx alone
      // cannot recover whether these attempts succeeded or failed.
      if ((entry.schema || 1) < 2 && entry.outcome === 'failed' && entry.status >= 200 && entry.status < 300) entry = { ...entry, outcome: 'unknown' };
      const known = Number.isSafeInteger(entry.input) || Number.isSafeInteger(entry.output);
      const input = count(entry.input) + (entry.client === 'claude' ? count(entry.cached) + count(entry.cacheWrite) : 0);
      const cost = !entry.account && !entry.image && Number.isSafeInteger(entry.input) && Number.isSafeInteger(entry.output)
        ? officialTokenCost(entry.model, input, count(entry.output), count(entry.cached), count(entry.cacheWrite), count(entry.cacheWriteLong)) : null;
      add(summary, entry, input, cost, known); const day = daily.get(dateKey(entry.at)); if (day) add(day, entry, input, cost, known);
      const key = group === 'models' ? JSON.stringify([entry.client, entry.model, !entry.model && !!entry.image]) : JSON.stringify([entry.client, entry.provider]);
      const row = groups.get(key) || { ...totals(), client: entry.client, ...(group === 'models' ? { model: entry.model, image: !!entry.image } : { provider: entry.provider }) };
      add(row, entry, input, cost, known); groups.set(key, row);
      if (group === 'requests') {
        let lo = 0, hi = logs.length;
        while (lo < hi) { const middle = (lo + hi) >>> 1; if (logs[middle].at > entry.at) lo = middle + 1; else hi = middle; }
        const limit = (page + 1) * 25;
        if (lo < limit) logs.splice(lo, 0, { ...entry, input: known ? input : null, cost, total: known ? input + count(entry.output) : null });
        if (logs.length > limit) logs.pop();
      }
      if (summary.requests >= 100000) { truncated = true; break; }
  }
  logs.sort((a, b) => b.at - a.at);
  return { summary, daily: [...daily].map(([date, values]) => ({ date, ...values })), rows: group === 'requests' ? logs.slice(page * 25, (page + 1) * 25) : [...groups.values()].sort((a, b) => b.requests - a.requests),
    page, pages: Math.max(1, Math.ceil(summary.requests / 25)), group, source, counts: { requests: summary.requests, providers: providerNames.size, models: modelNames.size }, truncated, updatedAt: now };
}
export type UsageStats = Awaited<ReturnType<typeof usageStats>>;
