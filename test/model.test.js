import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { addProvider, readState, setModel, activate } from '../src/store.js';
import { chooseModel, applyModel } from '../src/model.js';
import { select } from '../src/select.js';

const models = [{ id: 'model-a', label: 'Model A', efforts: ['low', 'high'], defaultEffort: 'low' }, { id: 'model-b', label: 'Model B', efforts: [], defaultEffort: null }];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-model-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  addProvider('api', { type: 'api', baseUrl: 'https://example.com', apiKey: 'mock' }, root);
  return root;
}
test('model and supported effort are saved together without changing the provider', async t => {
  const root = fixture(t), choices = [];
  const result = await chooseModel(root, {
    discoverImpl: async () => ({ models, notice: 'catalog notice' }),
    selectImpl: async (title, options, config) => { choices.push(options); if (choices.length === 1) assert.equal(config.subtitle, 'catalog notice'); return choices.length === 1 ? 1 : 2; },
  });
  assert.deepEqual(choices[1], ['服务商默认', 'low', 'high']);
  assert.deepEqual(result.selection, { model: 'model-a', effort: 'high' });
  assert.deepEqual(readState(root).modelSelection, result.selection);
  assert.equal(readState(root).active, 'api');
});
test('cancelling either step preserves the previous complete selection', async t => {
  const root = fixture(t); setModel({ model: 'old', effort: 'low' }, root);
  const previous = readState(root);
  for (const values of [[null], [1, null]]) {
    const result = await chooseModel(root, { discoverImpl: async () => ({ models }), selectImpl: async () => values.shift() });
    assert.equal(result.cancelled, true); assert.deepEqual(readState(root), previous);
  }
});
test('follow Codex resets overrides and switching providers during the picker requires retry', async t => {
  const root = fixture(t); setModel({ model: 'old', effort: 'low' }, root);
  await chooseModel(root, { discoverImpl: async () => ({ models }), selectImpl: async () => 0 });
  assert.equal(readState(root).modelSelection, undefined);
  addProvider('other', { type: 'api', baseUrl: 'https://other.example', apiKey: 'mock' }, root);
  await assert.rejects(chooseModel(root, { discoverImpl: async () => ({ models }), selectImpl: async () => { activate('other', root); return 0; } }), /上游已变化/);
});
test('provider default effort removes inherited effort and preserves other reasoning options', () => {
  const payload = { model: 'old', reasoning: { effort: 'high', summary: 'auto' }, input: 'hello' };
  assert.deepEqual(applyModel(payload, { model: 'new', effort: null }).reasoning, { summary: 'auto' });
  assert.deepEqual(payload.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(applyModel({ ...payload, reasoning: { effort: 'low' } }, { model: 'new', effort: null }).reasoning, undefined);
  assert.equal(applyModel(payload, null), payload);
});
test('keyboard selection saves or cancels and restores terminal state', async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = raw => { input.isRaw = raw; };
    let text = ''; const output = new Writable({ write(chunk, encoding, done) { text += chunk; done(); } }); output.isTTY = true; output.rows = 6;
    const pending = select('Choose', ['a', 'b', 'c'], { input, output });
    input.write('\x1b[B'); input.write(cancel ? '\x03' : '\r');
    assert.equal(await pending, cancel ? null : 1);
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
    assert.ok(text.endsWith('\x1b[?25h\x1b[?1049l'));
  }
});
