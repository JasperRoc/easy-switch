// A real Chromium account bridge with simulated image pages; no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const modern of [false, true]) test(`saved OAuth and an empty browser profile (${modern ? 'contenteditable' : 'textarea'}) return images, edits and quota errors without manual login`, { skip: process.env.SWITCH_TEST_DESKTOP !== '1', timeout: 30000 }, async t => {
  const { _electron } = await import('playwright-core');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-account-image-browser-'));
  const app = await _electron.launch({ args: [fileURLToPath(new URL('./fixtures/account-images.cjs', import.meta.url))],
    env: { ...process.env, SWITCH_ACCOUNT_IMAGE_TEST_ROOT: root, SWITCH_ACCOUNT_IMAGE_MODERN: modern ? '1' : '0' }, timeout: 15000 });
  app.process().stderr?.resume();
  t.after(async () => { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  for (let index = 0; index < 100; index++) { if (await app.evaluate(() => !!globalThis.accountImageFixture)) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  for (const mode of ['image', 'edit', 'quota', 'prequota']) {
    const result = await app.evaluate((_e, mode) => globalThis.accountImageFixture.run(mode), mode);
    assert.equal(result.status, ['image', 'edit'].includes(mode) ? 200 : 429, JSON.stringify(result));
    if (result.status === 200) assert.ok(result.bytes > 100);
    assert.equal(result.visible, false); assert.equal(result.released, true); assert.equal(result.persistent, false);
  }
  assert.equal(fs.existsSync(path.join(root, 'auth.json')), false); assert.equal(fs.existsSync(path.join(root, 'config.toml')), false);
});
