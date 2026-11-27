import { createHash } from 'node:crypto';
import path from 'node:path';
import { accountAuth, atomic, type AccountProvider, type Client, type CodexAuth, type ProviderState } from '../src/store.js';
import { createUpstreamFetch, type UpstreamFetch } from '../src/network.js';
import { claudeAuth, claudeExpired, claudeToken, claudeProfileHeaders, type ClaudeAuth } from '../src/claude-auth.js';
import { claudeProfilePlan } from '../src/plans.js';

type UsageData = Partial<ReturnType<typeof normalizeUsage>> & { plan: string };
interface UsageView {
  status: 'loading' | 'ready' | 'signin' | 'unavailable';
  data?: UsageData | null;
  fetchedAt?: number | null;
  failure?: 'authentication' | 'forbidden' | 'connection';
  refreshing?: boolean;
}
interface UsageEntry extends UsageView {
  key: string; attemptedAt: number; abort?: AbortController; pending?: Promise<void> | null; failures?: number;
}
interface UsageOptions {
  root: string; client?: Client; fetchImpl?: UpstreamFetch; now?: () => number; intervalMs?: number;
  refreshAuth?: (provider: AccountProvider, signal: AbortSignal) => Promise<unknown>;
  changed?: () => void;
}

const fingerprint = (auth: CodexAuth | ClaudeAuth) => createHash('sha256').update(JSON.stringify('tokens' in auth ? auth.tokens : [auth.accessToken, auth.scopes])).digest('hex');
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeUsage(payload, now = Date.now()) {
  if (!payload || typeof payload.plan_type !== 'string') throw new Error('Invalid usage response');
  const windows = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window].filter(Boolean);
  const window = period => {
    const item = windows.find(item => {
      const seconds = number(item.limit_window_seconds);
      return seconds > 0 && (period === 'monthly' ? seconds >= 28 * 86400 && seconds <= 31 * 86400
        : period === 'weekly' ? seconds >= 6 * 86400 && seconds <= 8 * 86400 : seconds < 86400);
    });
    const used = number(item?.used_percent);
    if (!item || used === null) return null;
    const reset = number(item.reset_at), after = number(item.reset_after_seconds);
    return { remaining: Math.max(0, Math.min(100, 100 - used)),
      resetsAt: reset > 0 ? reset * 1000 : after !== null && after >= 0 ? now + after * 1000 : null };
  };
  const balance = number(payload.credits?.balance);
  return { plan: payload.plan_type.toLowerCase(), fiveHour: window('fiveHour'), weekly: window('weekly'), monthly: window('monthly'),
    credits: balance !== null && balance >= 0 ? balance : payload.credits?.has_credits === false && payload.credits?.unlimited !== true ? 0 : null, unlimited: payload.credits?.unlimited === true };
}

// Poll independently of inference. Only normalized limits cross the renderer IPC.
export class SubscriptionUsage {
  declare root: string;
  declare client: Client;
  declare fetchImpl?: UpstreamFetch;
  declare refreshAuth?: UsageOptions['refreshAuth'];
  declare now: () => number;
  declare intervalMs: number;
  declare entries: Map<string, UsageEntry>;
  declare closed: boolean;
  declare paused: boolean;
  declare changed: () => void;

  constructor({ root, client = 'codex', fetchImpl, refreshAuth, now = Date.now, intervalMs = 60000, changed = () => {} }: UsageOptions) {
    Object.assign(this, { root, client, fetchImpl, refreshAuth, now, intervalMs, changed });
    this.entries = new Map(); this.closed = false; this.paused = false;
  }
  snapshot(state: ProviderState, force: boolean | string = false) {
    const result: Record<string, UsageView> = {};
    for (const [alias, provider] of Object.entries(state.providers)) {
      if (provider.type !== 'account') continue;
      if (provider.enabled === false) { this.entries.get(alias)?.abort?.abort(); continue; }
      let auth: CodexAuth | ClaudeAuth;
      try { auth = this.client === 'claude' ? claudeAuth(provider) : accountAuth(provider); } catch { result[alias] = { status: 'signin' }; continue; }
      if (this.client === 'claude' && !(auth as ClaudeAuth).scopes?.includes('user:profile')) { result[alias] = { status: 'unavailable' }; continue; }
      const key = fingerprint(auth);
      let entry = this.entries.get(alias);
      if (!entry || entry.key !== key) {
        entry = { key, status: 'loading', fetchedAt: null, attemptedAt: -Infinity, data: null };
        this.entries.set(alias, entry);
      }
      const retryMs = Math.min(15 * 60000, this.intervalMs * 2 ** (entry.failures || 0));
      if (!this.closed && !this.paused && !entry.pending && (force === true || force === alias || this.now() - entry.attemptedAt >= retryMs)) {
        entry.attemptedAt = this.now(); entry.pending = this.load(provider, auth, entry).finally(() => { entry.pending = null; this.changed(); });
      }
      result[alias] = { status: entry.status, fetchedAt: entry.fetchedAt, data: entry.data, refreshing: !!entry.pending,
        ...(entry.failure ? { failure: entry.failure } : {}) };
    }
    for (const alias of this.entries.keys()) if (!state.providers[alias]) { this.entries.get(alias).abort?.abort(); this.entries.delete(alias); }
    return result;
  }
  async load(provider: AccountProvider, auth: CodexAuth | ClaudeAuth, entry: UsageEntry) {
    const abort = new AbortController(); entry.abort = abort;
    delete entry.failure;
    let client;
    const claude = this.client === 'claude';
    const request = credentials => (this.fetchImpl || client.fetch)(claude ? 'https://api.anthropic.com/api/oauth/profile' : 'https://chatgpt.com/backend-api/wham/usage', {
      headers: claude ? claudeProfileHeaders(credentials.accessToken)
        : { authorization: `Bearer ${credentials.tokens.access_token}`, 'ChatGPT-Account-ID': credentials.tokens.account_id,
          accept: 'application/json', originator: 'codex_cli_rs' },
      redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    try {
      client = this.fetchImpl ? null : createUpstreamFetch(this.root);
      const refreshClaude = async force => {
        try { await claudeToken(provider, this.fetchImpl || client.fetch, { signal: abort.signal, force }); }
        catch (error) { if (!abort.signal.aborted && error.code === 'CLAUDE_AUTH_REQUIRED') { entry.status = 'signin'; entry.failure = 'authentication'; } throw error; }
        auth = claudeAuth(provider); entry.key = fingerprint(auth);
      };
      if (claude && claudeExpired(auth as ClaudeAuth) && (auth as ClaudeAuth).refreshToken) {
        await refreshClaude(false);
      }
      let response = await request(auth);
      if (abort.signal.aborted) { await response.body?.cancel(); return; }
      if (response.status === 401 && (this.refreshAuth || claude && (auth as ClaudeAuth).refreshToken)) {
        await response.body?.cancel();
        if (claude) await refreshClaude(true);
        else await this.refreshAuth(provider, abort.signal);
        if (abort.signal.aborted) return;
        auth = claude ? claudeAuth(provider) : accountAuth(provider); entry.key = fingerprint(auth);
        response = await request(auth);
      }
      if (!response.ok) {
        await response.body?.cancel();
        entry.status = response.status === 401 ? 'signin' : 'unavailable';
        entry.failure = response.status === 401 ? 'authentication' : response.status === 403 ? 'forbidden' : 'connection';
        entry.failures = (entry.failures || 0) + 1; return;
      }
      const payload = await response.json();
      if (claude) {
        const plan = claudeProfilePlan(payload);
        if (!plan) throw new Error('Unknown Claude plan');
        const current = claudeAuth(provider);
        if (abort.signal.aborted || current.accessToken !== (auth as ClaudeAuth).accessToken) return;
        const rateLimitTier = typeof payload.organization?.rate_limit_tier === 'string' ? payload.organization.rate_limit_tier : null;
        if (current.subscriptionType !== plan || current.rateLimitTier !== rateLimitTier || current.subscriptionTypeSource !== 'profile' || !Number.isFinite(current.subscriptionTypeVerifiedAt)) {
          atomic(path.join(provider.accountHome, 'oauth.json'), { ...current, subscriptionType: plan, rateLimitTier, subscriptionTypeSource: 'profile', subscriptionTypeVerifiedAt: this.now() });
        }
        entry.data = { plan };
      } else entry.data = normalizeUsage(payload, this.now());
      entry.fetchedAt = this.now(); entry.status = 'ready'; entry.failures = 0;
      delete entry.failure;
    } catch { if (!abort.signal.aborted) { if (entry.failure !== 'authentication') { entry.status = 'unavailable'; entry.failure = 'connection'; } entry.failures = (entry.failures || 0) + 1; } }
    finally {
      if (abort.signal.aborted) entry.attemptedAt = -Infinity;
      delete entry.abort; await client?.close();
    }
  }
  setPaused(paused) { this.paused = paused; if (paused) for (const entry of this.entries.values()) entry.abort?.abort(); }
  close() { this.closed = true; for (const entry of this.entries.values()) entry.abort?.abort(); }
}
