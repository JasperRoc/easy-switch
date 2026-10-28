import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const enabled = process.env.SWITCH_TEST_DESKTOP === '1';
const project = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.SWITCH_TEST_DESKTOP_EXE;
async function launch(t) {
  const { _electron } = await import('playwright-core');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-electron-'));
  const root = path.join(directory, 'switch'), home = path.join(directory, 'codex');
  fs.mkdirSync(home);
  const file = path.join(home, 'config.toml'), original = '# Original user config\nmodel="gpt-6.1-sol"\n';
  fs.writeFileSync(file, original);
  // Never touch the developer's credentials, configuration or login items.
  const app = await _electron.launch({ ...(executable ? { executablePath: executable, args: [] } : { args: [project] }),
    env: { ...process.env, SWITCH_HOME: root, CODEX_HOME: home, SWITCH_CODEX_BIN: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*' }, timeout: 20000 });
  app.process().stderr?.resume();
  t.after(async () => { await app.close().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.locator('#status').filter({ hasText: 'Routing active' }).waitFor();
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider, 'easy_switch');
  return { app, page, file, original, root };
}
test('desktop GUI, bundled catalog, tray lifetime and normal restoration', { skip: !enabled, timeout: 60000 }, async t => {
  const upstream = http.createServer((req,res) => {
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] }));
  }).listen(0,'127.0.0.1'); await once(upstream,'listening');
  t.after(() => upstream.close());
  const { app,page,file,original } = await launch(t);
  const uiErrors = []; page.on('pageerror', error => uiErrors.push(error.message));
  await page.click('#add-provider'); await page.fill('#provider-alias','personal'); await page.selectOption('#provider-type','api');
  await page.fill('#base-url',`http://127.0.0.1:${upstream.address().port}/v1`); await page.fill('#api-key','fixture-only'); await page.click('#save-provider');
  await page.locator('.provider strong').filter({ hasText:'personal' }).waitFor();
  await page.click('[data-tab="model"]');
  await page.locator('#model-select option[value="gpt-6.1-sol"]').waitFor({state:'attached'});
  await page.selectOption('#model-select','gpt-6.1-sol'); await page.selectOption('#effort-select','high'); await page.click('#model-form button[type="submit"]');
  await page.locator('#current-model').filter({hasText:'gpt-6.1-sol · high'}).waitFor();
  const state = await page.evaluate(() => window.easySwitch.call('state'));
  assert.equal(state.providers[0].apiKey, undefined); assert.equal(JSON.stringify(state).includes('fixture-only'), false);
  await page.click('#routing-toggle'); await page.locator('#status').filter({hasText:'Routing stopped'}).waitFor();
  assert.equal(fs.readFileSync(file,'utf8'),original);
  await page.click('#routing-toggle'); await page.locator('#status').filter({hasText:'Routing active'}).waitFor();
  const image = path.join(project,'.desktop-test','settings.png'); fs.mkdirSync(path.dirname(image),{recursive:true}); await page.screenshot({path:image});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider,'easy_switch');
  const changed = fs.readFileSync(file,'utf8').replace('model="gpt-6.1-sol"','model="user-changed"'); fs.writeFileSync(file,changed);
  await app.close();
  assert.equal(parse(fs.readFileSync(file,'utf8')).model,'user-changed');
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider,undefined);
  assert.deepEqual(uiErrors,[]);
});
test('Electron recovery helper restores configuration after main process is killed', { skip: !enabled,timeout:30000 }, async t => {
  const { app,file,original,root } = await launch(t);
  const child = app.process(); const exit = once(child,'exit'); child.kill('SIGKILL'); await exit;
  for (let attempt=0; attempt<100 && fs.existsSync(path.join(root,'desktop-session.json')); attempt++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(fs.existsSync(path.join(root,'desktop-session.json')),false);
});
