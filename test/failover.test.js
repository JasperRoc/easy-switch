import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverable, rejectionText, rejectionStatus, atCapacity, capacityDelay, modelUnavailable } from '../src/failover.js';
test('model access classification requires explicit model errors and never treats safety, parameters or capacity as access failures', () => {
  for (const message of [
    '{"error":{"code":"model_not_found","message":"The requested model does not exist or you do not have access to it."}}',
    '{"detail":"The gpt-example model is not supported when using Codex with a ChatGPT account."}',
    '{"error":{"type":"permission_error","message":"You do not have access to the requested model."}}',
    '当前账号无权限使用此模型', '该模型不支持当前套餐',
  ]) for (const status of [400, 403, 404]) assert.equal(modelUnavailable(status, message), true, message);
  for (const message of [
    'access denied', 'invalid effort parameter', 'unsupported image size', 'context window exceeded',
    '{"error":{"code":"content_policy_violation","message":"This model is not available for this content."}}',
    '{"error":{"code":"invalid_request_error","message":"invalid temperature"},"input":"model not found"}',
    'Selected model is at capacity. Please try a different model.',
  ]) assert.equal(modelUnavailable(400, message), false, message);
  assert.equal(modelUnavailable(503, 'model not found'), false);
});
test('capacity classification is explicit and Retry-After respects backoff and HTTP dates', () => {
  for (const text of ['Selected model is at capacity. Please try a different model.', '{"error":{"code":"server_overloaded"}}', '{"response":{"error":{"code":"model_at_capacity"}}}']) assert.equal(atCapacity(text), true);
  for (const text of ['invalid image', 'context window exceeded', 'internal server error', '{"error":{"code":"invalid_request","message":"denied"},"input":"Selected model is at capacity"}']) assert.equal(atCapacity(text), false);
  assert.equal(capacityDelay(null, 0), 1000); assert.equal(capacityDelay('0', 1), 2000);
  assert.equal(capacityDelay('10', 0), 10000);
  assert.equal(capacityDelay('Thu, 01 Jan 1970 00:00:15 GMT', 1, 0), 15000);
});
test('server policy retries provider-level access failures but preserves explicit safety and region restrictions', () => {
  for (const status of [401,402,429]) assert.equal(recoverable(status), true);
  for (const text of ['', 'Forbidden: access denied', '<html>403 Forbidden</html>', '团队 今日额度不足', 'insufficient_quota', 'quota exhausted', '余额不足']) assert.equal(recoverable(403, text), true);
  for (const text of ['{"error":{"code":"content_policy_violation","message":"denied"}}', '{"error":"content_policy_violation"}', 'refused for safety', 'unsupported_country_region_territory', 'organization policy denied access', '违反内容安全政策']) assert.equal(recoverable(403, text), false);
  assert.equal(recoverable(403, '{"error":{"message":"Forbidden"},"input":"safety policy"}'), true);
  for (const status of [400,408,500,503]) assert.equal(recoverable(status, 'access denied'), false);
  assert.equal(rejectionStatus({ status: '403' }), 403);
  assert.equal(rejectionStatus({ type: 'permission_error' }), 403);
  assert.equal(rejectionStatus({ status_code: 503 }), 503);
  assert.equal(rejectionStatus({ type: 'server_error' }), 500);
  assert.equal(rejectionStatus({ code: '__proto__' }), undefined);
  assert.equal(rejectionStatus({ code: 'invalid_request_error' }), undefined);
});
test('error classification reads no more than 64 KiB and cancels remaining body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(70000).fill(65)); }, cancel() { cancelled = true; } });
  assert.equal((await rejectionText(new Response(stream))).length, 65536);
  assert.equal(cancelled, true);
});

test('quota errors are recognized in subscription, API and nested SSE formats without matching input or policy refusals', () => {
  for (const code of ['usage_limit_reached', 'insufficient_quota', 'rate_limit_exceeded', 'rate_limit_reached']) {
    assert.equal(rejectionStatus({ code }), 429);
    assert.equal(rejectionStatus(JSON.stringify({ response: { error: { type: code } } })), 429);
  }
  for (const code of ['insufficient_balance', 'insufficient_credits', 'credits_exhausted', 'billing_hard_limit_reached']) assert.equal(rejectionStatus({ code }), 402);
  for (const message of ["You've hit your usage limit", 'Your usage limit reached', 'credit balance exhausted', '额度已用尽', '余额不足']) assert.equal(rejectionStatus({ message }), 429, message);
  assert.equal(rejectionStatus('{"error":{"code":"invalid_request_error"},"input":"quota exhausted"}'), undefined);
  assert.equal(recoverable(429, 'content_policy_violation'), false);
});

test('priority order skips failed, cooling, attempted, and unavailable providers', async () => {
  const { alternate } = await import('../src/failover.js');
  const api = { type: 'api', apiKey: 'key', baseUrl: 'https://example.com/v1' };
  const state = { providers: { a: api, b: api, c: api, invalid: { type: 'account', accountHome: '/missing-test-account' } }, order: ['invalid', 'c', 'b', 'a'] };
  assert.equal(alternate(state, 'a', new Map(), 0), 'c');
  assert.equal(alternate(state, 'a', new Map([['c', 100]]), 0), 'b');
  assert.equal(alternate(state, 'a', new Map(), 0, new Set(['c'])), 'b');
  delete state.order;
  assert.equal(alternate(state, 'a', new Map(), 0), 'b');
});
