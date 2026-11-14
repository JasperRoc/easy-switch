import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionUsage, normalizeUsage } from '../desktop/usage.js';
import { planLabel } from '../src/plans.js';
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

test('normalize usage by window duration, retaining credits and missing fields without inventing percentages', () => {
  const data = normalizeUsage(payload(), 1000);
  assert.equal(data.fiveHour.remaining, 75); assert.equal(data.weekly.remaining, 20);
  assert.equal(data.fiveHour.resetsAt, 1900000000000); assert.equal(data.weekly.resetsAt, 3601000);
  assert.equal(data.credits, 36.445);
  const swapped = payload('pro'); [swapped.rate_limit.primary_window, swapped.rate_limit.secondary_window] = [swapped.rate_limit.secondary_window, swapped.rate_limit.primary_window];
  assert.equal(normalizeUsage(swapped).weekly.remaining, 20);
  assert.deepEqual(normalizeUsage({ plan_type: 'pro', credits: { balance: null } }), { plan: 'pro', fiveHour: null, weekly: null, credits: null, unlimited: false });
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
