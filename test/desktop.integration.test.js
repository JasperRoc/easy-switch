import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { codexThread } from './fixtures/codex-metadata.js';

const enabled = process.env.SWITCH_TEST_DESKTOP === '1';
const project = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.SWITCH_TEST_DESKTOP_EXE;
async function launch(t, extraEnv = {}, initialConfig) {
  const { _electron } = await import('playwright-core');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-electron-'));
  const root = path.join(directory, 'switch'), home = path.join(directory, 'codex');
  fs.mkdirSync(home); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'desktop.json'), JSON.stringify({ language: 'en', theme: 'light' }));
  const file = path.join(home, 'config.toml'), original = initialConfig ?? '# Original user config\nmodel="gpt-6.1-sol"\n';
  fs.writeFileSync(file, original);
  // Never touch the developer's credentials, configuration or login items.
  const options = { ...(executable ? { executablePath: executable, args: [] } : { args: [project] }),
    env: { ...process.env, SWITCH_HOME: root, CODEX_HOME: home, SWITCH_CODEX_BIN: '', SWITCH_PORT: '0', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', ...extraEnv }, timeout: 20000 };
  const app = await _electron.launch(options);
  app.process().stderr?.resume();
  t.after(async () => {
    await app.windows()[0]?.evaluate(() => window.easySwitch.call('stop')).catch(() => {});
    await app.close().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.locator('#status').filter({ hasText: 'Routing active' }).waitFor();
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider, 'easy_switch');
  return { app, page, file, original, root, home, options };
}
test('desktop GUI, bundled catalog, tray lifetime and normal restoration', { skip: !enabled, timeout: 60000 }, async t => {
  const upstream = http.createServer((req,res) => {
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'relay-only-model' }] }));
  }).listen(0,'127.0.0.1'); await once(upstream,'listening');
  t.after(() => upstream.close());
  const { app,page,file,original } = await launch(t);
  const uiErrors = []; page.on('pageerror', error => uiErrors.push(error.message));
  await page.click('#add-api'); await page.fill('#provider-alias','personal');
  await page.fill('#base-url',`http://127.0.0.1:${upstream.address().port}/v1`); await page.fill('#api-key','fixture-only'); await page.click('#save-provider');
  await page.locator('.provider strong').filter({ hasText:'personal' }).waitFor();
  await page.click('[data-tab="model"]');await page.click('#global-model');
  await page.locator('#catalog-status').filter({hasText:'Catalog refreshed · 2 models'}).waitFor();
  await page.click('#model-picker'); await page.fill('#model-search','relay-only');
  await page.locator('[data-model="relay-only-model"]').click();
  assert.equal(await page.locator('#effort-options button').count(), 1);
  await page.click('#model-picker'); await page.fill('#model-search','gpt-6.1-sol');
  await page.locator('[data-model="gpt-6.1-sol"]').click(); await page.click('[data-effort="high"]');
  await page.click('#model-form button[type="submit"]');
  await page.locator('#current-model').filter({hasText:'gpt-6.1-sol · high'}).waitFor();
  const state = await page.evaluate(() => window.easySwitch.call('state'));
  assert.equal(state.providers[0].apiKey, undefined); assert.equal(JSON.stringify(state).includes('fixture-only'), false);
  await page.click('[data-tab="network"]');
  assert.match(await page.locator('#local-proxy').innerText(), /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(await page.locator('#detected-proxy').innerText(), 'No proxy detected');
  await page.screenshot({path:path.join(project,'.desktop-test','connection.png')});
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

test('desktop language and glass themes update live and persist across application restarts', { skip: !enabled, timeout: 60000 }, async t => {
  const { app, page, root, options } = await launch(t);
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await page.locator('#add-subscription').filter({hasText:'添加订阅'}).waitFor();
  await page.click('#theme-button'); await page.click('button[data-theme="dark"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.click('#add-subscription');
  assert.equal(await page.locator('#save-provider').innerText(), '添加订阅');
  await page.click('#close-dialog'); await page.click('#add-api');
  assert.equal(await page.locator('#save-provider').innerText(), '添加 API 服务商');
  await page.click('#close-dialog');
  assert.equal(await page.locator('#quit').count(),0);
  assert.match(await page.locator('#version').innerText(),/^easy-switch /);
  assert.match(await page.locator('.glass').first().evaluate(element=>getComputedStyle(element).backdropFilter), /blur/);
  const folder=path.join(project,'.desktop-test'); fs.mkdirSync(folder,{recursive:true});
  await page.screenshot({path:path.join(folder,'ocean-dark-zh.png')});
  await page.click('#theme-button'); await page.click('button[data-theme="light"]'); await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await page.screenshot({path:path.join(folder,'ocean-light-zh.png')});
  await page.click('#theme-button'); await page.click('button[data-theme="dark"]'); await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'desktop.json'))), {language:'zh-CN',theme:'dark'});
  await app.close();
  const {_electron}=await import('playwright-core'); const reopened=await _electron.launch(options);
  try {
    const second=await reopened.firstWindow();
    await second.locator('#status').filter({hasText:'路由已启用'}).waitFor();
    assert.equal(await second.locator('html').getAttribute('lang'),'zh-CN');
    assert.equal(await second.locator('html').getAttribute('data-theme'),'dark');
    await second.click('#language-button'); await second.click('[data-language="en"]'); await second.locator('#add-subscription').filter({hasText:'Add subscription'}).waitFor();
  } finally {await reopened.close();}
});
test('grip dragging, deletion, explicit import and in-app release review work without opening Releases', {skip:!enabled,timeout:60000},async t=>{
 const {app,page,root}=await launch(t);
 for(const alias of ['alpha','beta','gamma']) await page.evaluate(alias=>window.easySwitch.call('add-api',{alias,key:'fixture-'+alias}),alias);
 await page.locator('.provider').nth(2).waitFor();
 await page.locator('.drag-handle').nth(2).dragTo(page.locator('.provider').first(),{targetPosition:{x:100,y:3}});
 await page.waitForFunction(async()=>JSON.stringify((await window.easySwitch.call('state')).providers.map(p=>p.alias))===JSON.stringify(['gamma','alpha','beta']));
 await page.waitForFunction(()=>document.querySelector('.provider')?.dataset.alias==='gamma');
 page.once('dialog',dialog=>dialog.accept());await page.locator('.provider[data-alias="gamma"] .delete-provider').click();
 await page.waitForFunction(async()=>(await window.easySwitch.call('state')).providers.length===2);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).providers.gamma,undefined);
 await page.click('#import-existing');assert.match(await page.locator('#provider-dialog-title').innerText(),/Import current/);assert.equal(await page.locator('#import-login').count(),0);await page.click('#close-dialog');

 await page.click('#updates'); await page.locator('#update-dialog').waitFor({state:'visible'}); await page.locator('#update-title').waitFor(); assert.equal(await page.locator('#update-notes script').count(),0);
 await page.click('#close-update'); await page.click('#star');
 const folder=path.join(project,'.desktop-test');await page.screenshot({path:path.join(folder,'liquid-light.png')});
 await page.click('#theme-button');await page.click('button[data-theme="dark"]');await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await page.screenshot({path:path.join(folder,'liquid-dark.png')});
});

test('subscription verification stays in its dialog and disappears after approval', { skip: !enabled || process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-login-ui-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const binary = path.join(fixture, 'codex'), approval = path.join(fixture, 'approved');
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
console.log('https://auth.openai.com/codex/device TEST-1234');
const timer = setInterval(() => { if (!fs.existsSync(process.env.SWITCH_TEST_APPROVAL)) return;
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({tokens:{access_token:'fixture-only',account_id:'fixture-account'}}));
clearInterval(timer); process.exit(0); }, 50);
`, { mode: 0o700 });
  const { page } = await launch(t, { SWITCH_CODEX_BIN: binary, SWITCH_TEST_APPROVAL: approval });
  // Exercise the same IPC and authentication flow without opening a browser.
  await page.click('#add-subscription'); await page.fill('#provider-alias', 'subscription');
  await page.evaluate(() => window.easySwitch.call('login', 'subscription'));
  await page.locator('#login-code').filter({ hasText: 'TEST-1234' }).waitFor();
  assert.equal(await page.locator('#add-dialog #login-status').count(), 1);
  assert.equal(await page.locator('#save-provider').isDisabled(), true);
  await page.screenshot({path:path.join(project,'.desktop-test','subscription-pending.png')});
  await page.click('#close-dialog'); await page.click('#add-api');
  assert.equal(await page.locator('#login-status').isVisible(), false);
  await page.click('#close-dialog'); await page.click('#add-subscription');
  assert.equal(await page.locator('#provider-alias').inputValue(), 'subscription');
  fs.writeFileSync(approval, 'approved');
  await page.locator('#save-provider').filter({ hasText: 'Done' }).waitFor();
  assert.equal(await page.locator('#login-code').innerText(), '');
  assert.equal(await page.locator('#open-login').isVisible(), false);
  assert.equal(await page.locator('#provider-alias').isDisabled(), false);
  await page.screenshot({path:path.join(project,'.desktop-test','subscription-complete.png')});
  await page.click('#save-provider'); assert.equal(await page.locator('#add-dialog').isVisible(), false);
  await page.locator('.provider strong').filter({ hasText: 'subscription' }).waitFor();
});

test('API configuration import previews its type, close icons center, network fields explain bypass, and model refresh confirms success', {skip:!enabled,timeout:60000}, async t => {
  const upstream = http.createServer((_req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{id:'gpt-6.1-sol'},{id:'relay-model'}]})); }).listen(0,'127.0.0.1'); await once(upstream,'listening');t.after(()=>upstream.close());
  const original=`model_provider="relay"\n[model_providers.relay]\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nexperimental_bearer_token="fixture-import-secret"\n`;
  const {page}=await launch(t,{},original);
  const centered=async id=>{const button=await page.locator('#'+id).boundingBox(),glyph=await page.locator('#'+id+' svg').boundingBox(); assert.ok(Math.abs(button.x+button.width/2-glyph.x-glyph.width/2)<1);assert.ok(Math.abs(button.y+button.height/2-glyph.y-glyph.height/2)<1);};
  await page.click('#import-existing');await page.locator('#import-preview').filter({hasText:'Detected API provider'}).waitFor();
  assert.equal(await page.locator('#provider-alias').inputValue(),'relay');await centered('close-dialog');
  assert.equal((await page.locator('#import-preview').innerText()).includes('fixture-import-secret'),false);
  await page.click('#save-provider');await page.locator('.provider strong').filter({hasText:'relay'}).waitFor();
  await page.click('[data-tab="model"]');await page.click('#global-model');await page.locator('#catalog-status').filter({hasText:'Catalog refreshed · 2 models'}).waitFor();
  await page.click('#refresh-models');await page.locator('#refresh-models:not([disabled])').waitFor();
  assert.match(await page.locator('#catalog-status').innerText(),/2 models/);
  await page.click('#model-picker');await page.fill('#model-search','relay-model');await page.press('#model-search','ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await page.locator('#model-select').inputValue(),'relay-model');assert.match(await page.locator('#effort-help').innerText(),/No effort metadata/);
  await page.click('#model-picker');
  const menu=await page.locator('#model-menu').boundingBox(),viewport=await page.locator('main').boundingBox();
  assert.ok(menu.y>=viewport.y && menu.y+menu.height<=viewport.y+viewport.height, 'Model menu must remain inside the scroll viewport');
  const folder=path.join(project,'.desktop-test');await page.screenshot({path:path.join(folder,'model-picker.png')});
  await page.click('[data-tab="network"]');assert.equal(await page.locator('#proxy-url').getAttribute('type'),'url');
  assert.equal(await page.locator('#no-proxy').isVisible(),false);await page.locator('#network-advanced summary').click();
  assert.match(await page.locator('[data-i18n="bypassHelp"]').innerText(),/connect directly/);
  await page.screenshot({path:path.join(folder,'connection-explained.png')});
  await page.click('#updates');await page.locator('#update-dialog').waitFor({state:'visible'});await centered('close-update');
});

test('desktop targets a running session, aligns effort controls and localizes structured update notes', { skip: !enabled, timeout: 60000 }, async t => {
  const received = [], streams = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.1-codex' }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk; received.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"part":1}\n\n'); streams.push(res);
  }).listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const { app, page, root, home } = await launch(t);
  await page.evaluate(url => window.easySwitch.call('add-api', { alias: 'demo', url, key: 'fixture' }), `http://127.0.0.1:${upstream.address().port}/v1`);
  await page.locator('.provider strong').filter({ hasText: 'demo' }).waitFor();
  const endpoint = (await page.evaluate(() => window.easySwitch.call('network'))).localProxy.url;
  const token = JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).token;
  const responses = [];
  const tasks = [];
  for (const [id, text] of [['task-a', 'Repair the search feature'], ['task-b', 'Review the database migration']]) {
    const thread = codexThread(home, id, text); tasks.push(thread);
    responses.push(await fetch(endpoint + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, ...thread.headers }, body: JSON.stringify({ model: 'gpt-5.1-codex', input: 'Internal request, not a task title' }) }));
  }
  responses.push(await fetch(endpoint + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'thread-id': 'ephemeral-helper' }, body: JSON.stringify({ model: 'gpt-5.1-codex', input: 'Generate a title' }) }));
  await page.click('[data-tab="model"]'); await page.locator('[data-session="task-a"]').waitFor();
  assert.equal(await page.locator('[data-session]').count(), 2);
  assert.equal(await page.locator('[data-session="task-a"] strong').innerText(), 'Repair the search feature');
  assert.equal(await page.locator('#apply-model').isDisabled(), true);
  await page.click('[data-session="task-a"]');
  await page.click('#model-picker'); await page.locator('[data-model="gpt-6.1-sol"]').click();
  const picker = await page.locator('#model-picker').boundingBox(), effort = await page.locator('[data-effort=""]').boundingBox();
  assert.ok(Math.abs(picker.y + picker.height / 2 - effort.y - effort.height / 2) < 1, 'Effort and model controls must share a centerline');
  await page.click('[data-effort="high"]'); await page.click('#apply-model');
  await page.locator('#model-feedback').filter({ hasText: 'Saved for Repair the search feature' }).waitFor();
  const modelState = JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
  assert.equal(modelState.modelSelection, undefined); assert.equal(modelState.sessionModels['task-a'].model, 'gpt-6.1-sol'); assert.equal(modelState.sessionModels['task-b'], undefined);
  const folder = path.join(project, '.desktop-test'); await page.screenshot({ path: path.join(folder, 'session-model.png') });
  for (const stream of streams) stream.end('data: [DONE]\n\n');
  await Promise.all(responses.map(response => response.text())); assert.ok(received.every(body => body.model === 'gpt-5.1-codex'));
  tasks[1].event('task_complete');
  await page.waitForFunction(() => document.querySelectorAll('[data-session]').length === 1);
  assert.equal(await page.locator('[data-session="task-a"] .session-state').innerText(), 'Task continuing');
  tasks[0].event('task_complete');
  await page.locator('#sessions-empty').waitFor();
  assert.equal(await page.locator('[data-session]').count(), 0);
  assert.equal(await page.locator('#apply-model').isDisabled(), true);
  assert.equal(await page.locator('#model-feedback').isVisible(), false);
  await page.screenshot({ path: path.join(folder, 'sessions-finished.png') });

  // Replace only this isolated test app's update IPC response; no real release or install is changed.
  await app.evaluate(({ ipcMain }) => {
    const notes = '<!-- easy-switch:notes:en -->\n## Improvements\n- Switch a single **session**.\n<!-- easy-switch:notes:zh-CN -->\n## 功能改进\n- 为单条**会话**切换模型。\n';
    ipcMain.removeHandler('easy-switch:call');
    ipcMain.handle('easy-switch:call', (_event, action) => {
      if (action === 'state') return globalThis.easySwitchTestState;
      if (action === 'updates') return {};
      if (action === 'preferences') { globalThis.easySwitchTestState.language = globalThis.easySwitchTestState.language === 'en' ? 'zh-CN' : 'en'; return {}; }
    });
    globalThis.easySwitchTestNotes = notes;
  });
  const uiState = { running: true, providers: [], sessions: [], active: 'demo', version: '0.4.3', language: 'en', dark: false, theme: 'light', platform: process.platform,
    update: { phase: 'available', version: '0.4.4', date: '2026-10-31T00:00:00Z', size: 1024 ** 2 } };
  await app.evaluate((_electron, state) => { globalThis.easySwitchTestState = { ...state, update: { ...state.update, notes: globalThis.easySwitchTestNotes } }; }, uiState);
  await page.click('#updates'); await page.locator('#update-notes').filter({ hasText: 'Switch a single' }).waitFor();
  assert.equal(await page.locator('#update-notes li strong').innerText(), 'session');
  await page.screenshot({ path: path.join(folder, 'update-en.png') });
  await page.click('#close-update'); await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await page.click('#updates'); await page.locator('#update-notes').filter({ hasText: '为单条会话切换模型' }).waitFor();
  assert.equal((await page.locator('#update-notes').innerText()).includes('Switch a single'), false);
  assert.equal((await page.locator('#update-notes').innerText()).includes('<!--'), false);
  await page.screenshot({ path: path.join(folder, 'update-zh.png') });
  await app.evaluate(() => { globalThis.easySwitchTestState.update = { phase: 'current', checkedAt: Date.now() }; });
  await page.click('#update-retry'); await page.locator('#update-title').filter({ hasText: '已经是最新版本' }).waitFor();
  assert.equal(await page.locator('#update-warning').isVisible(), false); assert.equal(await page.locator('#update-changes').isVisible(), false);
  assert.equal((await page.locator('#update-status').innerText()).includes('最新版本'), false);
  await page.screenshot({ path: path.join(folder, 'update-current.png') });
});
