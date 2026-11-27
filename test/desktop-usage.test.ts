import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionUsage, normalizeUsage } from '../desktop/usage.js';
import { planLabel, claudeSavedPlan, claudeProfilePlan } from '../src/plans.js';
import { atomic } from '../src/store.js';

const payload = (plan = 'plus') => ({ plan_type: plan, rate_limit: {
  primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1900000000 },
  secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_after_seconds: 3600 },
}, credits: { has_credits: true, balance: '36.445', unlimited: false } });
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-quota-')), accountHome = path.join(root, 'account');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'secret-fixture', account_id: 'account-fixture' } });
  const state = { providers: { account: { type: 'account', accountHome }, api: { type: 'api', apiKey: 'never-send' } } };
  const usage = new SubscriptionUsage({ root, ...options }); t.after(() => usage.close());
  return { usage, state, accountHome };
}
const done = usage => Promise.all([...usage.entries.values()].map(entry => entry.pending));

test('Claude active subscription flags override a legacy Pro organization, while contradictory saved plans stay unknown', () => {
  assert.equal(claudeProfilePlan({ account: { has_claude_pro: false, has_claude_max: false }, organization: { organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai' } }), 'free');
  assert.equal(claudeProfilePlan({ account: { has_claude_pro: true, has_claude_max: false }, organization: { organization_type: 'claude_pro' } }), 'pro');
  assert.equal(claudeProfilePlan({ account: { has_claude_pro: true, has_claude_max: true }, organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }), 'ultra');
  assert.equal(claudeProfilePlan({ account: {}, organization: {} }), null);
  assert.equal(claudeProfilePlan({ account: { has_claude_pro: false }, organization: {} }), null);
  assert.equal(claudeProfilePlan({ account: { has_claude_pro: false, has_claude_max: false }, organization: { organization_type: 'claude_team' } }), 'team');
  assert.equal(claudeSavedPlan({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }), null);
  assert.equal(claudeSavedPlan({ subscriptionType: 'free', rateLimitTier: 'default_claude_ai' }), 'free');
  assert.equal(claudeSavedPlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), 'ultra');
});

test('verified Free replaces a stale saved Pro and survives a fresh app instance without exposing account details', async t => {
  const { usage, state, accountHome } = setup(t, { client: 'claude', fetchImpl: async () => Response.json({
    account: { uuid: 'private-user', email: 'private@example.test', has_claude_pro: false, has_claude_max: false },
    organization: { uuid: 'private-org', organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai' },
  }) });
  const auth = { accessToken: 'private-access', refreshToken: 'private-refresh', subscriptionType: 'pro', rateLimitTier: 'default_claude_ai', scopes: ['user:profile', 'user:inference'] };
  atomic(path.join(accountHome, 'oauth.json'), auth);
  usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.data.plan, 'free');
  const saved = JSON.parse(fs.readFileSync(path.join(accountHome, 'oauth.json')));
  assert.equal(claudeSavedPlan(saved), 'free'); assert.equal(saved.subscriptionTypeSource, 'profile');
  assert.equal(saved.accessToken, auth.accessToken); assert.equal(saved.refreshToken, auth.refreshToken);
  assert.doesNotMatch(JSON.stringify(saved), /private-user|private-org|private@example/);
  const restarted = new SubscriptionUsage({ root: usage.root, client: 'claude', fetchImpl: async () => new Response('', { status: 403 }) });
  t.after(() => restarted.close()); restarted.snapshot(state); await done(restarted);
  assert.equal(claudeSavedPlan(JSON.parse(fs.readFileSync(path.join(accountHome, 'oauth.json')))), 'free');
});

test('a delayed profile cannot rewrite a replaced or removed Claude login', async t => {
  let respond;
  const { usage, state, accountHome } = setup(t, { client: 'claude', fetchImpl: () => new Promise(resolve => { respond = resolve; }) });
  const file = path.join(accountHome, 'oauth.json');
  const auth = { accessToken: 'old-access', subscriptionType: 'pro', scopes: ['user:profile'] };
  atomic(file, auth); usage.snapshot(state);
  const replacement = { ...auth, accessToken: 'other-access', subscriptionType: 'max' };
  atomic(file, replacement);
  respond(Response.json({ organization: { organization_type: 'claude_free' } })); await done(usage);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), replacement);
  usage.snapshot(state); fs.unlinkSync(file);
  respond(Response.json({ organization: { organization_type: 'claude_free' } })); await done(usage);
  assert.equal(fs.existsSync(file), false);
});

test('a verified Max downgrade also replaces the old Ultra rate tier in the saved login', async t => {
  const { usage, state, accountHome } = setup(t, { client: 'claude', fetchImpl: async () => Response.json({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' } }) });
  atomic(path.join(accountHome, 'oauth.json'), { accessToken: 'private-access', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', scopes: ['user:profile'] });
  usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.data.plan, 'max');
  assert.equal(claudeSavedPlan(JSON.parse(fs.readFileSync(path.join(accountHome, 'oauth.json')))), 'max');
});

test('Codex plan changes are reread with the same credentials after the cache interval and after resuming', async t => {
  let clock = 0, plan = 'free', calls = 0;
  const { usage, state } = setup(t, { now: () => clock, fetchImpl: async () => { calls++; return Response.json(payload(plan)); } });
  usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.data.plan, 'free');
  for (const next of ['plus', 'pro', 'free']) {
    plan = next; clock += 60000; usage.snapshot(state); await done(usage);
    assert.equal(usage.snapshot(state).account.data.plan, next);
  }
  usage.setPaused(true); plan = 'plus'; clock += 60000; usage.snapshot(state); await done(usage);
  assert.equal(calls, 4); assert.equal(usage.snapshot(state).account.data.plan, 'free');
  usage.setPaused(false); usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.data.plan, 'plus'); assert.equal(calls, 5);
});

test('Claude plans refresh online, retain the last known plan on failure and never guess Free from missing fields', async t => {
  let clock = 0, type = 'claude_free', tier = null, fail = false, calls = 0;
  const { usage, state, accountHome } = setup(t, { client: 'claude', now: () => clock, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.anthropic.com/api/oauth/profile');
    assert.equal(options.headers.authorization, 'Bearer claude-private'); assert.equal(options.redirect, 'error');
    return fail ? new Response('private error', { status: 503 }) : Response.json({ organization: { organization_type: type, rate_limit_tier: tier }, account: { email: 'private@example.test' } });
  } });
  atomic(path.join(accountHome, 'oauth.json'), { accessToken: 'claude-private', expiresAt: Date.now() + 3600000, scopes: ['user:inference', 'user:profile'] });
  for (const [next, nextTier, expected] of [['claude_free', null, 'free'], ['claude_pro', null, 'pro'], ['claude_max', 'default_claude_max_5x', 'max'], ['claude_max', 'default_claude_max_20x', 'ultra'], ['claude_free', null, 'free']]) {
    type = next; tier = nextTier; usage.snapshot(state); await done(usage);
    assert.equal(usage.snapshot(state).account.data.plan, expected); clock += 60000;
  }
  assert.equal(calls, 5);
  fail = true; usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.status, 'unavailable'); assert.equal(usage.snapshot(state).account.data.plan, 'free');
  fail = false; type = null; clock += 120000; usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.status, 'unavailable'); assert.equal(usage.snapshot(state).account.data.plan, 'free');
  assert.doesNotMatch(JSON.stringify(usage.snapshot(state)), /private|organization_type|accessToken/);
  assert.equal(usage.snapshot(state).api, undefined);
});

test('Claude plan reads respect foreground pause and missing profile permission', async t => {
  let calls = 0;
  const { usage, state, accountHome } = setup(t, { client: 'claude', fetchImpl: async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const auth = { accessToken: 'claude-private', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] };
  atomic(path.join(accountHome, 'oauth.json'), auth);
  assert.equal(usage.snapshot(state).account.status, 'unavailable'); assert.equal(calls, 0);
  atomic(path.join(accountHome, 'oauth.json'), { ...auth, scopes: ['user:inference', 'user:profile'] });
  usage.snapshot(state); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); usage.setPaused(true); await done(usage);
  for (let index = 0; index < 10; index++) usage.snapshot(state);
  assert.equal(calls, 1);
  usage.setPaused(false); usage.snapshot(state);
  assert.equal(calls, 2); usage.close(); await done(usage);
});

test('Claude profile authentication refreshes once on rejection and preserves the saved plan metadata', async t => {
  let profiles = 0, refreshes = 0;
  const { usage, state, accountHome } = setup(t, { client: 'claude', fetchImpl: async (url, options) => {
    if (url === 'https://platform.claude.com/v1/oauth/token') {
      refreshes++; assert.equal(JSON.parse(options.body).refresh_token, 'private-refresh');
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    }
    profiles++;
    if (profiles === 1) return new Response('', { status: 401 });
    assert.equal(options.headers.authorization, 'Bearer new-access');
    return Response.json({ organization: { organization_type: 'claude_pro' } });
  } });
  atomic(path.join(accountHome, 'oauth.json'), { accessToken: 'old-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000,
    subscriptionType: 'free', scopes: ['user:inference', 'user:profile'] });
  usage.snapshot(state); await done(usage);
  assert.equal(profiles, 2); assert.equal(refreshes, 1);
  assert.equal(usage.snapshot(state).account.data.plan, 'pro');
  const saved = JSON.parse(fs.readFileSync(path.join(accountHome, 'oauth.json')));
  assert.equal(saved.subscriptionType, 'pro'); assert.equal(saved.subscriptionTypeSource, 'profile'); assert.equal(saved.refreshToken, 'new-refresh');
});

test('pausing a Claude profile read cancels token refresh without changing the saved login', async t => {
  let refreshSignal;
  const { usage, state, accountHome } = setup(t, { client: 'claude', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://platform.claude.com/v1/oauth/token'); refreshSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const auth = { accessToken: 'old-access', refreshToken: 'private-refresh', expiresAt: 1, scopes: ['user:inference', 'user:profile'] };
  atomic(path.join(accountHome, 'oauth.json'), auth);
  usage.snapshot(state); await new Promise(resolve => setImmediate(resolve)); usage.setPaused(true); await done(usage);
  assert.equal(refreshSignal.aborted, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(accountHome, 'oauth.json'))), auth);
});

test('normalize usage by window duration, retaining credits and missing fields without inventing percentages', () => {
  const data = normalizeUsage(payload(), 1000);
  assert.equal(data.fiveHour.remaining, 75); assert.equal(data.weekly.remaining, 20);
  assert.equal(data.fiveHour.resetsAt, 1900000000000); assert.equal(data.weekly.resetsAt, 3601000);
  assert.equal(data.credits, 36.445);
  const swapped = payload('pro'); [swapped.rate_limit.primary_window, swapped.rate_limit.secondary_window] = [swapped.rate_limit.secondary_window, swapped.rate_limit.primary_window];
  assert.equal(normalizeUsage(swapped).weekly.remaining, 20);
  assert.deepEqual(normalizeUsage({ plan_type: 'pro', credits: { balance: null } }), { plan: 'pro', fiveHour: null, weekly: null, monthly: null, credits: null, unlimited: false });
  for (const value of [null, '', false, 'not-a-number']) {
    const input = payload(); input.rate_limit.primary_window.used_percent = value;
    assert.equal(normalizeUsage(input).fiveHour, null);
  }
});
test('quota polling sends account credentials only to the fixed endpoint, deduplicates, caches and exports sanitized fields', async t => {
  let calls = 0, clock = 1000;
  const { usage, state } = setup(t, { now: () => clock, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers.authorization, 'Bearer secret-fixture');
    assert.equal(options.headers['ChatGPT-Account-ID'], 'account-fixture'); assert.equal(options.redirect, 'error');
    return Response.json({ ...payload(), email: 'private@example.test', access_token: 'should-not-export' });
  } });
  usage.snapshot(state); usage.snapshot(state); await done(usage);
  const snapshot = usage.snapshot(state); assert.equal(calls, 1); assert.equal(snapshot.account.status, 'ready');
  assert.equal(snapshot.api, undefined); assert.doesNotMatch(JSON.stringify(snapshot), /secret|private|access_token|account-fixture/);
  clock += 60000; usage.snapshot(state); await done(usage); assert.equal(calls, 2);
});
test('quota refresh preserves stale data after failure, handles zero credits and never exposes raw server errors', async t => {
  let fail = false;
  const { usage, state } = setup(t, { fetchImpl: async () => fail ? new Response('raw credential-bearing error', { status: 503 }) : Response.json(payload()) });
  usage.snapshot(state); await done(usage); fail = true;
  usage.snapshot(state, true); await done(usage);
  const data = usage.snapshot(state).account;
  assert.equal(data.status, 'unavailable'); assert.equal(data.data.weekly.remaining, 20);
  assert.doesNotMatch(JSON.stringify(data), /credential-bearing/);
  const exhausted = payload('pro'); exhausted.rate_limit.secondary_window.used_percent = 100; exhausted.credits.balance = '0';
  assert.equal(normalizeUsage(exhausted).weekly.remaining, 0); assert.equal(normalizeUsage(exhausted).credits, 0);
});
test('unauthorized quota requests refresh existing credentials once, without starting interactive sign-in', async t => {
  let calls = 0, refreshes = 0;
  const { usage, state, accountHome } = setup(t, { fetchImpl: async (_url, options) => {
    if (++calls === 1) return new Response('', { status: 401 });
    assert.equal(options.headers.authorization, 'Bearer refreshed'); return Response.json(payload());
  }, refreshAuth: async () => { refreshes++; atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'refreshed', account_id: 'account-fixture' } }); } });
  usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.status, 'ready'); assert.equal(calls, 2); assert.equal(refreshes, 1);
});
test('background pause aborts quota and credential refresh, preserves cached data and resumes without duplicate requests', async t => {
  let calls = 0, hold = false, refreshSignal;
  const { usage, state } = setup(t, { fetchImpl: async () => {
    calls++; return hold ? new Response('', { status: 401 }) : Response.json(payload());
  }, refreshAuth: (_provider, signal) => {
    refreshSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  usage.snapshot(state); await done(usage); hold = true;
  usage.snapshot(state, true); await new Promise(resolve => setImmediate(resolve));
  assert.ok(refreshSignal); usage.setPaused(true); await done(usage);
  assert.equal(refreshSignal.aborted, true);
  for (let index = 0; index < 100; index++) usage.snapshot(state, true);
  assert.equal(calls, 2); assert.equal(usage.snapshot(state).account.data.credits, 36.445);
  assert.equal(usage.snapshot(state).account.status, 'ready');
  hold = false; usage.setPaused(false); usage.snapshot(state); usage.snapshot(state); await done(usage);
  assert.equal(calls, 3); assert.equal(usage.snapshot(state).account.status, 'ready');
});
test('repeated quota failures back off instead of launching authentication helpers every minute', async t => {
  let calls = 0, clock = 0;
  const { usage, state } = setup(t, { now: () => clock, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } });
  usage.snapshot(state); await done(usage); assert.equal(calls, 1);
  clock = 60000; usage.snapshot(state); await done(usage); assert.equal(calls, 1);
  clock = 120000; usage.snapshot(state); await done(usage); assert.equal(calls, 2);
  clock = 180000; usage.snapshot(state); await done(usage); assert.equal(calls, 2);
  clock = 360000; usage.snapshot(state); await done(usage); assert.equal(calls, 3);
});


test('zero quota and an explicit no-credits balance remain successful data, while missing fields stay unknown', async t => {
  const input = payload(); input.rate_limit.primary_window.used_percent = 100; input.rate_limit.secondary_window.used_percent = 100;
  input.credits = { has_credits: false, balance: null, unlimited: false };
  const data = normalizeUsage(input);
  assert.equal(data.fiveHour.remaining, 0); assert.equal(data.weekly.remaining, 0); assert.equal(data.credits, 0);
  assert.equal(normalizeUsage({ plan_type: 'plus', credits: { has_credits: true, balance: null } }).credits, null);
  const { usage, state } = setup(t, { fetchImpl: async () => Response.json(input) });
  usage.snapshot(state); await done(usage);
  assert.equal(usage.snapshot(state).account.status, 'ready'); assert.equal(usage.snapshot(state).account.data.credits, 0);
});

test('quota windows use their actual duration instead of treating monthly Free quota as weekly', () => {
  const result = normalizeUsage({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 2592000, reset_after_seconds: 60 } } });
  assert.equal(result.weekly, null); assert.equal(result.fiveHour, null);
  assert.deepEqual(result.monthly, { remaining: 100, resetsAt: result.monthly.resetsAt });
  for (const days of [28, 29, 30, 31]) {
    const data = normalizeUsage({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: days * 86400, reset_at: 1900000000 } } });
    assert.deepEqual(data.monthly, { remaining: 97, resetsAt: 1900000000000 });
    assert.equal(data.weekly, null);
  }
});


test('account plan identifiers preserve Free, Go, Plus and the three Pro tiers', () => {
  for (const [id, label] of [['free', 'Free'], ['go', 'Go'], ['plus', 'Plus'], ['prolite', 'Pro 100'], ['pro', 'Pro 200'], ['promax', 'Pro 500']]) assert.equal(planLabel(id), label);
  assert.equal(planLabel(null), null); assert.equal(planLabel('unknown'), null);
});

test('Go preserves its reported five-hour window and zero credits without inventing weekly quota', () => {
  const input = payload('go'); input.rate_limit.secondary_window = null; input.credits = { has_credits: false, balance: '0' };
  const result = normalizeUsage(input);
  assert.equal(result.plan, 'go'); assert.equal(result.fiveHour.remaining, 75);
  assert.equal(result.weekly, null); assert.equal(result.credits, 0);
});


test('Claude plan labels use its own Free, Pro, Max and Ultra names without changing Codex Pro', () => {
  for (const [id, label] of [['free', 'Free'], ['pro', 'Pro'], ['max', 'Max'], ['ultra', 'Ultra']]) assert.equal(planLabel(id, 'claude'), label);
  assert.equal(planLabel('pro'), 'Pro 200');
  assert.equal(planLabel('unknown', 'claude'), null); assert.equal(planLabel(null, 'claude'), null);
});

test('Claude profile requests include JSON OAuth headers and expired refresh failure is reported as sign-in required',async t=>{
 const {usage,state,accountHome}=setup(t,{client:'claude',fetchImpl:async(url,options)=>{
  assert.equal(options.headers['content-type'],'application/json');
  if(url.endsWith('/oauth/token'))return Response.json({error:'invalid_grant'},{status:400});
  assert.equal(options.headers['anthropic-beta'],'oauth-2025-04-20');
  return Response.json({organization:{organization_type:'claude_free'}});
 }});
 atomic(path.join(accountHome,'oauth.json'),{accessToken:'old',refreshToken:'old-refresh',expiresAt:1,subscriptionType:'pro',scopes:['user:profile']});
 usage.snapshot(state);await done(usage);
 assert.equal(usage.snapshot(state).account.status,'signin');assert.equal(usage.snapshot(state).account.failure,'authentication');
 const next={accessToken:'new',expiresAt:Date.now()+3600000,scopes:['user:profile']};atomic(path.join(accountHome,'oauth.json'),next);
 usage.snapshot(state);await done(usage);
 assert.equal(usage.snapshot(state).account.data.plan,'free');assert.equal(usage.snapshot(state).account.failure,undefined);
});
