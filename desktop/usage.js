import { createHash } from 'node:crypto';
import { accountAuth } from '../src/store.js';
import { createUpstreamFetch } from '../src/network.js';

const fingerprint = auth => createHash('sha256').update(JSON.stringify(auth.tokens)).digest('hex');
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeUsage(payload, now = Date.now()) {
  if (!payload || typeof payload.plan_type !== 'string') throw new Error('Invalid usage response');
  const windows = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window].filter(Boolean);
  const window = weekly => {
    const item = windows.find(item => {
      const seconds = number(item.limit_window_seconds);
      return seconds > 0 && (weekly ? seconds >= 86400 : seconds < 86400);
    });
    const used = number(item?.used_percent);
    if (!item || used === null) return null;
    const reset = number(item.reset_at), after = number(item.reset_after_seconds);
    return { remaining: Math.max(0, Math.min(100, 100 - used)),
      resetsAt: reset > 0 ? reset * 1000 : after !== null && after >= 0 ? now + after * 1000 : null };
  };
  const balance = number(payload.credits?.balance);
  return { plan: payload.plan_type.toLowerCase(), fiveHour: window(false), weekly: window(true),
    credits: balance !== null && balance >= 0 ? balance : null, unlimited: payload.credits?.unlimited === true };
}

// Poll independently of inference. Only normalized limits cross the renderer IPC.
export class SubscriptionUsage {
  constructor({ root, fetchImpl, refreshAuth, now = Date.now, intervalMs = 60000 }) {
    Object.assign(this, { root, fetchImpl, refreshAuth, now, intervalMs });
    this.entries = new Map(); this.closed = false;
  }
  snapshot(state, force = false) {
    const result = {};
    for (const [alias, provider] of Object.entries(state.providers)) {
      if (provider.type !== 'account') continue;
      let auth;
      try { auth = accountAuth(provider); } catch { result[alias] = { status: 'signin' }; continue; }
      const key = fingerprint(auth);
      let entry = this.entries.get(alias);
      if (!entry || entry.key !== key) {
        entry = { key, status: 'loading', fetchedAt: null, attemptedAt: -Infinity, data: null };
        this.entries.set(alias, entry);
      }
      if (!this.closed && !entry.pending && (force === true || force === alias || this.now() - entry.attemptedAt >= this.intervalMs)) {
        entry.attemptedAt = this.now(); entry.pending = this.load(provider, auth, entry).finally(() => { entry.pending = null; });
      }
      result[alias] = { status: entry.status, fetchedAt: entry.fetchedAt, data: entry.data, refreshing: !!entry.pending };
    }
    for (const alias of this.entries.keys()) if (!state.providers[alias]) { this.entries.get(alias).abort?.abort(); this.entries.delete(alias); }
    return result;
  }
  async load(provider, auth, entry) {
    const abort = new AbortController(); entry.abort = abort;
    let client;
    const request = credentials => (this.fetchImpl || client.fetch)('https://chatgpt.com/backend-api/wham/usage', {
      headers: { authorization: `Bearer ${credentials.tokens.access_token}`, 'ChatGPT-Account-ID': credentials.tokens.account_id,
        accept: 'application/json', originator: 'codex_cli_rs' },
      redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    try {
      client = this.fetchImpl ? null : createUpstreamFetch(this.root);
      let response = await request(auth);
      if (response.status === 401 && this.refreshAuth) {
        await response.body?.cancel();
        await this.refreshAuth(provider);
        if (abort.signal.aborted) return;
        auth = accountAuth(provider); entry.key = fingerprint(auth);
        response = await request(auth);
      }
      if (!response.ok) {
        await response.body?.cancel();
        entry.status = response.status === 401 ? 'signin' : 'unavailable'; return;
      }
      entry.data = normalizeUsage(await response.json(), this.now());
      entry.fetchedAt = this.now(); entry.status = 'ready';
    } catch { entry.status = 'unavailable'; }
    finally { delete entry.abort; await client?.close(); }
  }
  close() { this.closed = true; for (const entry of this.entries.values()) entry.abort?.abort(); }
}
