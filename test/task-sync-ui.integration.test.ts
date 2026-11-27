import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const enabled = process.env.SWITCH_TEST_RENDERER === '1';
const project = fileURLToPath(new URL('..', import.meta.url));

test('session client menu aligns controls and supports keyboard, loading and theme changes', { skip: !enabled, timeout: 20000 }, async t => {
  const server = http.createServer((request, response) => {
    const file = path.resolve(project, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(project)) { response.writeHead(404).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404).end(); return; }
      if (file.endsWith('index.html')) bytes = Buffer.from(bytes.toString().replace('<script type="module" src="native-bridge.js"></script>', ''));
      response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
      response.end(bytes);
    });
  }).listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.SWITCH_TEST_CHROMIUM || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome') });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 960, height: 780 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/desktop/index.html`);
  await page.evaluate(async () => {
    const { taskSyncUI } = await import('/desktop/task-sync.js');
    const state = { client: 'codex', kind: 'ssh', url: 'fixture', configured: true, enabled: true, hasPassphrase: true, phase: 'idle', tasks: [] };
    window.syncCalls = [];
    window.syncUI = taskSyncUI({ language: () => document.documentElement.lang, call: async (action, payload) => {
      window.syncCalls.push([action, payload]);
      if (action === 'sync-client') { await new Promise(resolve => { window.finishClientChange = resolve; }); state.client = payload; }
      return { ...state };
    } });
    document.getElementById('settings-page').hidden = false;
    document.getElementById('providers-page').hidden = true;
    document.getElementById('open-task-sync').click();
  });
  const button = page.locator('#sync-client'), menu = page.locator('#sync-client-menu');
  await page.locator('#sync-library').waitFor();
  await page.waitForFunction(() => !document.getElementById('sync-client').disabled);
  const boxes = await page.locator('#sync-client, #sync-refresh, #sync-now').evaluateAll(controls => controls.map(control => {
    const { y, height } = control.getBoundingClientRect(); return { y, height };
  }));
  assert.ok(boxes.every(box => box.height === 36 && Math.abs(box.y - boxes[0].y) < 1));
  await button.press('ArrowDown');
  assert.equal(await page.locator('[data-sync-client="codex"]').evaluate(option => option === document.activeElement), true);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await button.isDisabled(), true);
  assert.equal(await menu.isVisible(), false);
  await page.evaluate(() => window.finishClientChange());
  await page.locator('#sync-client-label').filter({ hasText: 'Claude Code' }).waitFor();
  await page.waitForFunction(() => !document.getElementById('sync-client').disabled);
  assert.ok((await page.evaluate(() => window.syncCalls)).some(([action, client]) => action === 'sync-client' && client === 'claude'));
  await button.click(); await page.keyboard.press('Home'); await page.keyboard.press('End');
  assert.equal(await page.locator('[data-sync-client="claude"]').evaluate(option => option === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  assert.equal(await button.evaluate(control => control === document.activeElement), true);
  await button.click(); await page.locator('#sync-search').click();
  assert.equal(await menu.isVisible(), false);
  for (const [theme, language, width] of [['light', 'en', 960], ['dark', 'zh-CN', 740]]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(async ([theme, language]) => {
      const { translate } = await import('/desktop/i18n.js');
      document.documentElement.dataset.theme = theme; document.documentElement.lang = language;
      for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = translate(language, element.dataset.i18n);
      window.syncUI.render();
    }, [theme, language]);
    await button.click();
    const layout = await menu.evaluate(menu => {
      const box = menu.getBoundingClientRect(); return { left: box.left, right: box.right, radius: getComputedStyle(menu).borderRadius, width: innerWidth, scrollWidth: document.body.scrollWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.scrollWidth === layout.width);
    assert.equal(layout.radius, '18px');
    assert.equal(await page.locator('[data-sync-client="claude"]').getAttribute('aria-checked'), 'true');
    fs.mkdirSync(path.join(project, '.desktop-test'), { recursive: true });
    await page.locator('#sync-page').screenshot({ path: path.join(project, '.desktop-test', `sync-client-menu-${theme}.png`), animations: 'disabled' });
    await page.keyboard.press('Tab');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await page.locator('#sync-refresh').evaluate(control => control === document.activeElement), true);
  }
  await button.click(); await page.click('#sync-storage-tab');
  assert.equal(await menu.isVisible(), false);
});
