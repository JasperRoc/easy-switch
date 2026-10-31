import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionUsage, normalizeUsage } from '../desktop/usage.js';
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
