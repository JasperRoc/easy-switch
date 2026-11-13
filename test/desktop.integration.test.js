import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { addProvider, init } from '../src/store.js';

const enabled = process.env.SWITCH_TEST_DESKTOP === '1';
const project = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.SWITCH_TEST_DESKTOP_EXE;
async function launch(t, extraEnv = {}, initialConfig, prepare) {
  const { _electron } = await import('playwright-core');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-electron-'));
  const root = path.join(directory, 'switch'), home = path.join(directory, 'codex');
  fs.mkdirSync(home); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'desktop.json'), JSON.stringify({ language: 'en', theme: 'light' }));
  const file = path.join(home, 'config.toml'), original = initialConfig ?? '# Original user config\nmodel="gpt-6.1-sol"\n';
  fs.writeFileSync(file, original);
  prepare?.(root);
  const desktopHome = path.join(directory, 'desktop-clients'); fs.mkdirSync(path.join(desktopHome, 'Claude'), { recursive: true });
  // Never touch the developer's credentials, configuration or login items.
  const options = { ...(executable ? { executablePath: executable, args: [] } : { args: [project] }),
    env: { ...process.env, SWITCH_HOME: root, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), SWITCH_CLAUDE_DESKTOP_HOME: desktopHome, SWITCH_CODEX_BIN: '', SWITCH_PORT: '0', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', ...extraEnv }, timeout: 20000 };
  const app = await _electron.launch(options);
  app.process().stderr?.resume();
  t.after(async () => {
    await app.windows()[0]?.evaluate(() => window.easySwitch.call('stop')).catch(() => {});
    await app.close().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.bringToFront();
  await page.locator('#status').filter({ hasText: /Routing active|路由已启用/ }).waitFor();
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider, 'easy_switch');
  return { app, page, file, original, root, home, options };
}
test('an unreadable desktop.json cannot block startup; the warning clears when file access returns', { skip: !enabled || process.platform === 'win32', timeout: 30000 }, async t => {
  const { app, page, root } = await launch(t, {}, undefined, directory => {
    init(directory); addProvider('saved', { type: 'api', baseUrl: 'https://api.example/v1', apiKey: 'fixture-private' }, directory);
    fs.chmodSync(path.join(directory, 'desktop.json'), 0);
  });
  const file = path.join(root, 'desktop.json');
  await page.locator('#preferences-warning').filter({ hasText: 'EACCES' }).waitFor();
  await page.locator('.provider strong').filter({ hasText: 'saved' }).waitFor();
  await page.click('#theme-button'); await page.click('[data-theme="dark"]');
  await page.locator('#error').filter({ hasText: 'desktop.json' }).waitFor();
  assert.equal(fs.statSync(file).mode & 0o777, 0);
  fs.chmodSync(file, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { language: 'en', theme: 'light' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed'));
  await page.locator('#preferences-warning').waitFor({ state: 'hidden' });
  await page.click('#language-button'); await page.click('[data-language="en"]');
  fs.chmodSync(file, 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed'));
  await page.locator('#preferences-warning').filter({ hasText: 'Desktop preferences could not be read' }).waitFor();
  fs.chmodSync(file, 0o600);
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  fs.chmodSync(file, 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed'));
  await page.locator('#preferences-warning').filter({ hasText: '无法读取界面设置' }).waitFor();
  fs.chmodSync(file, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { language: 'zh-CN', theme: 'light' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).providers.saved.apiKey, 'fixture-private');
});
test('desktop GUI, bundled catalog, tray lifetime and normal restoration', { skip: !enabled, timeout: 60000 }, async t => {
  const upstream = http.createServer((req,res) => {
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'relay-only-model' }, { id: 'gpt-6-luna' }, { id: 'gpt-6.1-terra' }, { id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] }));
  }).listen(0,'127.0.0.1'); await once(upstream,'listening');
  t.after(() => upstream.close());
  const { app,page,file,original,root } = await launch(t);
  const uiErrors = []; page.on('pageerror', error => uiErrors.push(error.message));
  await page.click('#add-api'); await page.fill('#provider-alias','personal');
  await page.fill('#base-url',`http://127.0.0.1:${upstream.address().port}/v1`); await page.fill('#api-key','fixture-only'); await page.click('#save-provider');
  await page.locator('.provider strong').filter({ hasText:'personal' }).waitFor();
  assert.equal(await page.locator('#routing-toggle').getAttribute('role'), 'switch');
  assert.equal(await page.locator('#routing-toggle').getAttribute('aria-checked'), 'true');
  const layout = await page.evaluate(() => {
    const status = document.getElementById('status').getBoundingClientRect(), control = document.getElementById('routing-toggle').getBoundingClientRect();
    return { statusCenter: status.y + status.height / 2, controlCenter: control.y + control.height / 2 };
  });
  assert.ok(Math.abs(layout.statusCenter - layout.controlCenter) < 1, 'route status and switch share a center line');
  assert.equal(await page.locator('[data-tab="model"], #model, #current-model').count(), 0);
  await page.locator('.query-models').click();
  await page.locator('#models-status').filter({ hasText: 'Catalog refreshed · 5 models' }).waitFor();
  assert.equal(await page.locator('.catalog-id').first().inputValue(), 'gpt-6.1-sol');
  const endpoint = parse(fs.readFileSync(file, 'utf8')).model_providers.easy_switch.model_catalog_url;
  const token = JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).token;
  const catalog = await (await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(catalog.models.map(model => model.slug), ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'relay-only-model']);
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(catalog.models[0].default_reasoning_level, 'low');
  await page.fill('#models-search', 'relay-only'); assert.equal(await page.locator('.catalog-model').count(), 1);
  assert.equal(await page.locator('.catalog-id').inputValue(), 'relay-only-model');
  await page.click('#close-models');
  await page.evaluate(url => window.easySwitch.call('add-api', { alias: 'inactive', url, key: 'fixture-inactive' }), `http://127.0.0.1:${upstream.address().port}/v1`);
  await page.locator('.provider[data-alias="inactive"] .query-models').click();
  await page.locator('#models-status').filter({ hasText: 'Catalog refreshed · 5 models' }).waitFor();
  assert.equal((await page.evaluate(() => window.easySwitch.call('state'))).active, 'personal');
  assert.match(await page.locator('#models-provider').innerText(), /inactive/);
  await page.click('#close-models');
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await page.click('#theme-button'); await page.click('[data-theme="dark"]');
  await page.locator('.provider[data-alias="inactive"] .query-models').click();
  await page.locator('#models-status').filter({ hasText: '目录已刷新 · 5 个模型' }).waitFor();
  await page.screenshot({ path: path.join(project, '.desktop-test', 'provider-models-dark-zh.png') });
  await page.click('#close-models');
  await page.click('#language-button'); await page.click('[data-language="en"]');
  await page.click('#theme-button'); await page.click('[data-theme="light"]');
  const state = await page.evaluate(() => window.easySwitch.call('state'));
  assert.equal(state.providers[0].apiKey, undefined); assert.equal(JSON.stringify(state).includes('fixture-only'), false);
  assert.equal(await page.locator('nav, #network, #network-form').count(), 0);
  await page.click('#routing-toggle'); await page.locator('#status').filter({hasText:'Routing stopped'}).waitFor();
  assert.equal(await page.locator('#routing-toggle').getAttribute('aria-checked'), 'false');
  assert.equal(fs.readFileSync(file,'utf8'),original);
  await page.click('#routing-toggle'); await page.locator('#status').filter({hasText:'Routing active'}).waitFor();
  const image = path.join(project,'.desktop-test','settings.png'); fs.mkdirSync(path.dirname(image),{recursive:true}); await page.screenshot({path:image});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider,'easy_switch');
  await app.evaluate(({ app }) => app.emit('activate'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const window = BrowserWindow.getAllWindows()[0]; window.once('minimize', resolve); window.minimize();
  }));
  await app.evaluate(({ app, BrowserWindow }) => new Promise(resolve => {
    const window = BrowserWindow.getAllWindows()[0]; window.once('restore', resolve); app.emit('activate');
  }));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), false);
  const changed = fs.readFileSync(file,'utf8').replace('model="gpt-6.1-sol"','model="user-changed"'); fs.writeFileSync(file,changed);
  await app.close();
  assert.equal(parse(fs.readFileSync(file,'utf8')).model,'user-changed');
  assert.equal(parse(fs.readFileSync(file,'utf8')).model_provider,undefined);
  assert.deepEqual(uiErrors,[]);
});
test('provider editing and separate Claude model mappings work in the desktop UI', { skip: !enabled, timeout: 30000 }, async t => {
  const upstream = http.createServer((_req, res) => { res.writeHead(404); res.end(); }).listen(0, '127.0.0.1');
  await once(upstream, 'listening'); t.after(() => upstream.close());
  const { app, page, root, options } = await launch(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.click('#add-api'); await page.fill('#provider-alias', 'old'); await page.fill('#api-key', 'original-secret');
  await page.fill('#base-url', `http://127.0.0.1:${upstream.address().port}/v1`); await page.click('#save-provider');
  await page.locator('.edit-provider').click(); assert.equal(await page.locator('#api-key').inputValue(), '');
  await page.fill('#provider-alias', 'renamed'); await page.click('#save-provider');
  await page.locator('.provider strong').filter({ hasText: 'renamed' }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).providers.renamed.apiKey, 'original-secret');
  await page.click('[data-client="claude"]'); await page.locator('#empty').waitFor();
  assert.match(await page.locator('[data-i18n="clientHelp"]').innerText(), /Claude Code CLI and Claude Desktop/);
  await page.click('#add-api'); assert.match(await page.locator('#base-url').getAttribute('placeholder'), /Anthropic/);
  assert.equal(await page.locator('#claude-mapping').isVisible(), false, 'adding a Claude API starts with the same simple fields as Codex');
  assert.equal(await page.locator('#claude-fable-model').isVisible(), false);
  await page.screenshot({ path: path.join(project, '.desktop-test', 'claude-add-api-0.5.15-en.png') });
  await page.fill('#provider-alias', 'renamed'); await page.fill('#api-key', 'claude-secret');
  await page.fill('#base-url', `http://127.0.0.1:${upstream.address().port}/anthropic`); await page.click('#save-provider');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'claude', 'state.json'))).providers.renamed.claudeModels, undefined);
  await page.locator('.query-models').click(); await page.locator('#models-status.failed').waitFor();
  await page.click('#close-models'); await page.locator('.edit-provider').click();
  assert.equal(await page.locator('#claude-mapping').getAttribute('open'), '');
  await page.locator('#claude-mapping>details>summary').click();
  await page.fill('#claude-main-model', 'deepseek-main'); await page.fill('#claude-agent-model', 'deepseek-agent'); await page.click('#save-provider');
  await page.locator('#add-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'claude', 'state.json'))).providers.renamed.claudeModels, { default: 'deepseek-main', subagent: 'deepseek-agent' });
  const claudeFile = path.join(options.env.CLAUDE_CONFIG_DIR, 'settings.json');
  assert.match(JSON.parse(fs.readFileSync(claudeFile)).env.ANTHROPIC_BASE_URL, /\/claude$/);
  assert.equal(JSON.parse(fs.readFileSync(claudeFile)).env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'deepseek-main');
  await page.locator('.edit-provider').click(); await page.screenshot({ path: path.join(project, '.desktop-test', 'claude-mapping.png') }); await page.click('#close-dialog');
  await page.click('[data-client="codex"]'); await page.locator('.provider[data-alias="renamed"]').waitFor();
  await page.evaluate(() => window.easySwitch.call('stop')); assert.equal(fs.existsSync(claudeFile), false);
  assert.deepEqual(errors, []);
});
test('Claude Desktop setup and icon-only provider switches share the CLI route without rewriting its profile', { skip: !enabled, timeout: 30000 }, async t => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'deepseek-first' }, { id: 'deepseek-helper' }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ body: JSON.parse(Buffer.concat(chunks).toString()), key: req.headers['x-api-key'] });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'LOCAL_OK' }] }));
  }).listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close());
  const { page, root, options } = await launch(t);
  await page.click('[data-client="claude"]');
  await page.evaluate(async url => {
    await window.easySwitch.call('add-api', { alias: 'first', key: 'first-key', url, claudeModels: { default: 'deepseek-first', subagent: 'deepseek-helper' } });
    await window.easySwitch.call('add-api', { alias: 'second', key: 'second-key', url, claudeModels: { default: 'deepseek-second' } });
  }, `http://127.0.0.1:${upstream.address().port}/anthropic`);
  await page.locator('#claude-desktop-hint').waitFor();
  const library = path.join(options.env.SWITCH_CLAUDE_DESKTOP_HOME, 'Claude-3p', 'configLibrary');
  const meta = JSON.parse(fs.readFileSync(path.join(library, '_meta.json'))), file = path.join(library, `${meta.appliedId}.json`);
  const original = fs.readFileSync(file, 'utf8'), profile = JSON.parse(original);
  const send = async model => {
    const response = await fetch(profile.inferenceGatewayBaseUrl + '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${profile.inferenceGatewayApiKey}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Continue this task' }] }) });
    assert.equal(response.status, 200); await response.text();
  };
  await send('claude-sonnet-5'); assert.equal(calls.at(-1).body.model, 'deepseek-first');
  assert.equal(await page.locator('.provider .tag').count(), 0);
  const second = page.locator('.provider[data-alias="second"] .select-provider');
  assert.equal(await second.innerText(), ''); assert.equal(await second.getAttribute('aria-pressed'), 'false');
  await second.click(); await page.locator('#current-provider').filter({ hasText: /^second$/ }).waitFor();
  assert.equal(await second.getAttribute('aria-pressed'), 'true'); assert.equal(await second.locator('use').getAttribute('href'), 'assets/ui.svg#check');
  await send('claude-sonnet-5'); assert.equal(calls.at(-1).body.model, 'deepseek-second'); assert.equal(calls.at(-1).key, 'second-key');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(profile.inferenceModels, undefined);
  const catalog = await (await fetch(profile.inferenceGatewayBaseUrl + '/v1/models', { headers: { authorization: `Bearer ${profile.inferenceGatewayApiKey}` } })).json();
  assert.deepEqual(catalog.data.map(item => item.display_name), ['deepseek-first', 'deepseek-helper', 'deepseek-second']);
  assert.ok(catalog.data.every(item => item.description.startsWith('easy-switch · ')));
  const folder = path.join(project, '.desktop-test'); fs.mkdirSync(folder, { recursive: true });
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await page.locator('#claude-desktop-hint').filter({ hasText: '已接入 Claude Desktop' }).waitFor();
  await page.screenshot({ path: path.join(folder, 'claude-desktop-zh-light.png') });
  await page.click('#theme-button'); await page.click('button[data-theme="dark"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(folder, 'claude-desktop-zh-dark.png') });
  await page.evaluate(() => window.easySwitch.call('stop'));
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(options.env.CLAUDE_CONFIG_DIR, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'claude-desktop-session.json')), false);
});
test('Claude provider catalog assigns independent Fable, Opus and Haiku mappings without exposing the API key', { skip: !enabled, timeout: 30000 }, async t => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-1-flash' }, { id: 'deepseek-v4-flash' }] }));
  }).listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close());
  const { page, root } = await launch(t);
  await page.click('[data-client="claude"]'); await page.click('#add-api');
  await page.fill('#provider-alias', 'deepseek'); await page.fill('#api-key', 'private-catalog-key');
  await page.fill('#base-url', `http://127.0.0.1:${upstream.address().port}`); await page.click('#save-provider');
  await page.locator('.edit-provider').click(); await page.click('#claude-choose-model');
  const rows = page.locator('.catalog-model'); await rows.first().waitFor();
  await rows.first().locator('.catalog-label').fill('DeepSeek V4 Pro');
  await page.locator('#catalog-mappings summary').click();
  await page.fill('#catalog-fable', 'deepseek-v4-pro');
  await page.fill('#catalog-opus', 'deepseek-v4-1-flash');
  await page.fill('#catalog-haiku', 'deepseek-v4-flash');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'claude/state.json'))).providers.deepseek.claudeModels, undefined, 'mapping is a draft until Save');
  await page.click('#models-save'); await page.locator('#models-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#claude-fable-model').inputValue(), 'deepseek-v4-pro');
  assert.equal(await page.locator('#claude-opus-model').inputValue(), 'deepseek-v4-1-flash');
  assert.equal(await page.locator('#claude-haiku-model').inputValue(), 'deepseek-v4-flash');
  assert.equal(await page.locator('#claude-sonnet-model').inputValue(), '');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  await page.click('#save-provider'); await page.locator('#add-dialog').waitFor({ state: 'hidden' });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'claude/state.json'))).providers.deepseek;
  assert.deepEqual(saved.claudeModels, { fable: 'deepseek-v4-pro', opus: 'deepseek-v4-1-flash', haiku: 'deepseek-v4-flash' });
  assert.deepEqual(saved.modelCatalog, [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { id: 'deepseek-v4-1-flash', label: 'deepseek-v4-1-flash' }, { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }]);
  assert.equal(saved.apiKey, 'private-catalog-key');
  await page.locator('.edit-provider').click();
  await page.screenshot({ path: path.join(project, '.desktop-test', 'claude-family-mapping-en.png') });
  await page.click('#close-dialog');
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await page.locator('.edit-provider').click();
  assert.equal(await page.locator('#claude-fable-model').inputValue(), 'deepseek-v4-pro');
  assert.match(await page.locator('#claude-mapping [data-i18n="claudeMappingHelp"]').innerText(), /各系列独立设置/);
  await page.screenshot({ path: path.join(project, '.desktop-test', 'claude-family-mapping-zh.png') });
});

test('model catalog edits support cancel, ordering, explicit IDs and returning to automatic discovery', { skip: !enabled, timeout: 30000 }, async t => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  }).listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => upstream.close());
  const { page, root } = await launch(t);
  await page.click('#add-api'); await page.fill('#provider-alias', 'catalog'); await page.fill('#api-key', 'private-key');
  await page.fill('#base-url', `http://127.0.0.1:${upstream.address().port}/v1`); await page.click('#save-provider');
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).providers.catalog;
  await page.locator('.query-models').click(); await page.locator('.catalog-id').first().waitFor();
  await page.locator('.catalog-label').first().fill('Unsaved'); await page.click('#models-cancel');
  assert.equal(saved().modelCatalog, undefined);
  await page.locator('.query-models').click(); await page.locator('.catalog-id').first().waitFor();
  await page.locator('.catalog-model .drag-handle').first().press('ArrowDown');
  assert.equal(await page.locator('.catalog-id').first().inputValue(), 'model-b');
  await page.locator('.catalog-label').first().fill('Model B');
  await page.click('#models-add'); await page.locator('.catalog-id').last().fill('manual-model');
  await page.locator('.catalog-label').last().fill('Manual model');
  await page.click('#models-save'); await page.locator('#models-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(saved().modelCatalog, [{ id: 'model-b', label: 'Model B' }, { id: 'model-a', label: 'model-a' }, { id: 'manual-model', label: 'Manual model' }]);
  assert.equal(saved().apiKey, 'private-key');
  await page.locator('.query-models').click(); await page.locator('#models-status').filter({ hasText: 'Catalog refreshed' }).waitFor();
  await page.screenshot({ path: path.join(project, '.desktop-test', 'model-catalog-editor-en.png') });
  await page.click('#models-reset'); assert.equal(await page.locator('.catalog-id').count(), 2);
  await page.click('#models-save'); await page.locator('#models-dialog').waitFor({ state: 'hidden' });
  assert.equal(saved().modelCatalog, undefined);
});
test('Claude subscription can be deleted and added again, with authorization codes confined to the dialog', { skip: !enabled || process.platform === 'win32', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-fake-claude-')), binary = path.join(directory, 'claude');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('fs'),path=require('path');
process.stdout.write('https://claude.com/cai/oauth/authorize?code=true&state=fixture\\n');
process.stdin.once('data',()=>{fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-oauth-secret',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000,scopes:['user:inference']}}),{mode:0o600});process.exit(0);});\n`, { mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { page, root } = await launch(t, { SWITCH_CLAUDE_BIN: binary });
  await page.click('[data-client="claude"]'); await page.click('#add-subscription'); await page.fill('#provider-alias', 'personal');
  // Invoke login without opening a real browser for this simulated OAuth page.
  await page.evaluate(() => window.easySwitch.call('login', 'personal'));
  await page.locator('#claude-code-field').waitFor(); await page.fill('#authorization-code', 'fixture-code#state'); await page.click('#save-provider');
  await page.locator('#login-message').filter({ hasText: 'Signed in successfully.' }).waitFor();
  assert.equal(await page.locator('#claude-code-field').isVisible(), false); assert.equal(await page.locator('#authorization-code').inputValue(), '');
  const state = await page.evaluate(() => window.easySwitch.call('state')); assert.equal(state.providers[0].type, 'account');
  assert.ok(!JSON.stringify(state).includes('fixture-oauth-secret'));
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'claude', 'state.json'))).providers.personal;
  assert.equal(JSON.parse(fs.readFileSync(path.join(saved.accountHome, 'oauth.json'))).accessToken, 'fixture-oauth-secret');
  await page.click('#save-provider'); await page.locator('#add-dialog').waitFor({ state: 'hidden' });
  page.once('dialog', dialog => dialog.accept()); await page.locator('.provider[data-alias="personal"] .delete-provider').click();
  await page.locator('.provider[data-alias="personal"]').waitFor({ state: 'hidden' });
  assert.equal(fs.existsSync(saved.accountHome), false);
  await page.click('#add-subscription'); await page.fill('#provider-alias', 'personal');
  await page.evaluate(() => window.easySwitch.call('login', 'personal'));
  await page.locator('#claude-code-field').waitFor(); await page.fill('#authorization-code', 'fixture-second-code#state'); await page.click('#save-provider');
  await page.locator('#login-message').filter({ hasText: 'Signed in successfully.' }).waitFor();
  const renewed = JSON.parse(fs.readFileSync(path.join(root, 'claude', 'state.json'))).providers.personal;
  assert.notEqual(renewed.accountHome, saved.accountHome);
  assert.equal(JSON.parse(fs.readFileSync(path.join(renewed.accountHome, 'oauth.json'))).accessToken, 'fixture-oauth-secret');
});
test('idle UI avoids DOM churn; hidden, locked and sleeping windows stop foreground work while routing remains usable', { skip: !enabled, timeout: 30000 }, async t => {
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); }).listen(0, '127.0.0.1');
  await once(upstream, 'listening'); t.after(() => upstream.close());
  const { app, page, root, home } = await launch(t);
  await page.evaluate(url => window.easySwitch.call('add-api', { alias: 'idle-test', url, key: 'fixture' }), `http://127.0.0.1:${upstream.address().port}/v1`);
  await page.locator('.provider strong').filter({ hasText: 'idle-test' }).waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    globalThis.energySends = 0; globalThis.energyLoginReads = 0;
    const web = BrowserWindow.getAllWindows()[0].webContents, send = web.send.bind(web), read = app.getLoginItemSettings.bind(app);
    web.send = (channel, ...args) => { if (channel === 'easy-switch:changed') globalThis.energySends++; return send(channel, ...args); };
    app.getLoginItemSettings = (...args) => { globalThis.energyLoginReads++; return read(...args); };
  });
  await page.evaluate(() => {
    globalThis.energyMutations = 0;
    new MutationObserver(records => globalThis.energyMutations += records.length).observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  for (let index = 0; index < 20; index++) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed'));
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(await page.evaluate(() => globalThis.energyMutations), 0, 'unchanged state never rewrites the DOM');
  assert.equal(await app.evaluate(() => globalThis.energyLoginReads), 0, 'idle polling does not call OS login-item services');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const sent = await app.evaluate(() => globalThis.energySends);
  const endpoint = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).model_providers.easy_switch.base_url;
  const token = JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).token;
  const response = await fetch(endpoint + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'fixture', input: 'Keep routing while hidden' }) });
  assert.equal(response.status, 200); await response.text();
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(await app.evaluate(() => globalThis.energySends), sent, 'hidden renderer receives no periodic refresh');
  await app.evaluate(({ powerMonitor, BrowserWindow }) => { powerMonitor.emit('lock-screen'); powerMonitor.emit('suspend'); BrowserWindow.getAllWindows()[0].show(); });
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(await app.evaluate(() => globalThis.energySends), sent, 'sleep and lock suspend UI polling even if a window event arrives');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal(await app.evaluate(() => globalThis.energySends), sent, 'resuming does not bypass a screen lock');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  assert.ok(await app.evaluate(() => globalThis.energySends) > sent, 'unlock refreshes the visible window immediately');
});
test('subscription quota rings, purchased credits, stale data and image setup notices render in both languages and themes', { skip: !enabled, timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  const window = (remaining, hours) => ({ remaining, resetsAt: Date.now() + hours * 3600000 });
  const account = (alias, plan, weekly) => ({ alias, type: 'account', active: false, usage: { status: 'ready', fetchedAt: Date.now(),
    data: { plan, fiveHour: window(75, 5), weekly: window(weekly, 100), credits: 36.445, unlimited: false } } });
  const uiState = { running: true, imageTools: true, active: 'api', providers: [account('plus', 'plus', 67), account('pro', 'pro', 20), account('credits', 'pro', 0), { alias: 'api', type: 'api', active: true, baseUrl: 'https://api.example.com/v1' }],
    version: '0.5.4', language: 'en', dark: false, theme: 'light', platform: process.platform, update: { phase: 'idle' } };
  await app.evaluate(({ ipcMain, BrowserWindow, powerMonitor }, state) => {
    powerMonitor.emit('lock-screen'); // Keep periodic real snapshots from replacing this fixture.
    globalThis.easySwitchQuotaState = state; globalThis.easySwitchQuotaRefreshes = 0;
    globalThis.easySwitchResetAttempts = [];
    globalThis.easySwitchResetCards = { availableCount: 2, credits: [
      { id: 'soon', title: 'Soon-expiring card', status: 'available', resetType: 'codexRateLimits', expiresAt: 1900000000000, expiryKnown: true },
      { id: 'later', title: 'Later card', status: 'available', resetType: 'codexRateLimits', expiresAt: 2000000000000, expiryKnown: true },
      { id: 'expired', title: 'Expired card', status: 'available', resetType: 'codexRateLimits', expiresAt: 1000000000000, expiryKnown: true },
    ] };
    ipcMain.removeHandler('easy-switch:call');
    ipcMain.handle('easy-switch:call', (_event, action, payload) => {
      if (action === 'preferences') { Object.assign(state, payload); state.dark = payload.theme ? payload.theme === 'dark' : state.dark; }
      if (action === 'usage') globalThis.easySwitchQuotaRefreshes++;
      if (action === 'reset-cards') return globalThis.easySwitchResetCards;
      if (action === 'consume-reset') {
        globalThis.easySwitchResetAttempts.push(payload);
        if (globalThis.easySwitchResetAttempts.length === 1) throw new Error('Could not confirm the reset result. Retry the same card to avoid another redemption.');
        globalThis.easySwitchResetCards = { availableCount: 0, credits: [] };
        return { outcome: 'alreadyRedeemed', cards: globalThis.easySwitchResetCards };
      }
      return state;
    });
    BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed');
  }, uiState);
  const plus = page.locator('.provider[data-alias="plus"]'), pro = page.locator('.provider[data-alias="pro"]'), credits = page.locator('.provider[data-alias="credits"]');
  await plus.waitFor();
  assert.equal(await plus.locator('.quota-ring').count(), 1); assert.equal(await plus.locator('.quota-segment').count(), 2); assert.equal(await pro.locator('.quota-segment').count(), 1);
  const sizes = await page.locator('.provider').evaluateAll(rows => rows.map(row => ({ width: row.getBoundingClientRect().width, height: row.getBoundingClientRect().height })));
  assert.ok(sizes.every(size => Math.abs(size.width - sizes[0].width) < 1 && Math.abs(size.height - sizes[0].height) < 1), 'API and subscription rows have identical dimensions: ' + JSON.stringify(sizes));
  await plus.locator('.quota-ring').hover({ position: { x: 16, y: 3 } });
  await plus.locator('.quota-tooltip').filter({ hasText: '5h: 75% remaining' }).waitFor();
  assert.notEqual(await plus.locator('.quota-segment:not(.weekly)').evaluate(element => getComputedStyle(element).transform), 'none');
  await plus.locator('.quota-ring').hover({ position: { x: 16, y: 29 } });
  await plus.locator('.quota-tooltip').filter({ hasText: 'Week: 67% remaining' }).waitFor();
  await pro.locator('.quota').hover(); await page.mouse.move(100, 100);
  assert.equal(await plus.locator('.quota-tooltip').isVisible(), false);
  assert.equal(await plus.locator('.quota-segment.weekly .quota-progress').getAttribute('stroke-dashoffset'), '33');
  assert.match(await plus.locator('.quota-segment.weekly').getAttribute('aria-label'), /67% remaining/);
  assert.equal(await page.locator('.quota-credits, .quota-balance').count(), 0);
  for (const row of [plus, pro, credits]) {
    await row.locator('.quota-center').focus(); await row.locator('.quota-tooltip').filter({ hasText: '36.445' }).waitFor();
    await row.locator('.quota-center').evaluate(element => element.blur());
  }
  assert.equal(await credits.locator('.quota-segment').count(), 1);
  assert.equal(await plus.locator('.quota-center').count(), 1);
  await page.locator('#native-images').filter({ hasText: 'Text route: api (Official / third-party API)' }).waitFor(); await page.mouse.move(100, 100);
  assert.equal(await app.evaluate(() => globalThis.easySwitchQuotaRefreshes), 0);
  assert.equal(await plus.locator('.quota-tooltip').isVisible(), false, 'clicking the quota does not expand all details');
  await plus.locator('.quota-segment.weekly').focus();
  await plus.locator('.quota-tooltip').filter({ hasText: 'Week: 67% remaining' }).waitFor();
  await plus.locator('.quota-segment.weekly').evaluate(element => element.blur());
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await credits.locator('.quota-center').focus(); await credits.locator('.quota-tooltip').filter({ hasText: '剩余购买额度' }).waitFor();
  await credits.locator('.quota-center').evaluate(element => element.blur());
  await credits.locator('.quota-center').hover();
  assert.equal(await credits.locator('.quota-center-hit').evaluate(element => getComputedStyle(element).cursor), 'default');
  await credits.locator('.quota-tooltip').filter({ hasText: '剩余购买额度' }).waitFor();
  await page.mouse.move(100, 100);
  assert.match(await plus.locator('.quota-segment.weekly').getAttribute('aria-label'), /周额度：剩余 67%/);
  const folder = path.join(project, '.desktop-test'); fs.mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, 'quota-light.png') });
  await plus.locator('.quota-ring').hover({ position: { x: 16, y: 3 } });
  await plus.locator('.quota-tooltip').filter({ hasText: '5 小时：剩余 75%' }).waitFor();
  await page.waitForFunction(() => {
    const tooltip = document.querySelector('[data-alias="plus"] .quota-tooltip');
    return tooltip && !tooltip.hidden && getComputedStyle(tooltip).opacity === '1';
  });
  await page.screenshot({ path: path.join(folder, 'quota-hover.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await plus.locator('.quota-segment:not(.weekly)').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await page.mouse.move(100, 100);
  await page.click('#theme-button'); await page.click('button[data-theme="dark"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(folder, 'quota-dark.png') });
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis.easySwitchQuotaState; state.providers[0].usage.status = 'unavailable';
    state.providers[1].usage = { status: 'unavailable', data: null }; state.imageTools = false;
    BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed');
  });
  await plus.locator('.quota.stale').waitFor(); await pro.locator('.quota-message').filter({ hasText: '额度暂不可用' }).waitFor();
  assert.equal(await plus.locator('.quota-segment').count(), 2); assert.equal(await page.locator('#native-images').isVisible(), false);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.easySwitchQuotaState.imageToolsBlocked = true;
    BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed');
  });
  await page.locator('#native-images').filter({ hasText: 'Free 账号无法启用' }).waitFor();
  await page.click('#language-button'); await page.click('[data-language="en"]');
  await page.locator('#native-images').filter({ hasText: 'Free accounts cannot enable' }).waitFor();
  await page.click('#language-button'); await page.click('[data-language="zh-CN"]');
  await plus.locator('.reset-quota').click();
  await page.locator('#reset-status').filter({ hasText: '共有 2 张可用重置卡' }).waitFor();
  assert.equal(await page.locator('#reset-confirm').isDisabled(), true, 'a card must be chosen explicitly');
  assert.equal(await page.locator('[data-credit-id="expired"]').isDisabled(), true);
  assert.match(await page.locator('[data-credit-id="soon"]').innerText(), /过期时间/);
  await page.locator('[data-credit-id="later"]').click();
  await page.screenshot({ path: path.join(folder, 'reset-cards-zh.png') });
  await page.click('#reset-confirm');
  await page.locator('#reset-error').filter({ hasText: '无法确认重置结果' }).waitFor();
  await page.click('#close-reset'); await plus.locator('.reset-quota').click();
  await page.locator('#reset-confirm').filter({ hasText: '重试同一次重置' }).waitFor();
  await page.click('#reset-confirm');
  await page.locator('#reset-result').filter({ hasText: '这次重置已完成' }).waitFor();
  const attempts = await app.evaluate(() => globalThis.easySwitchResetAttempts);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts[0].creditId, 'later');
  assert.equal(await page.locator('#reset-confirm').isDisabled(), true);
  assert.match(await plus.locator('.quota-center').getAttribute('aria-label'), /36.445/);
  assert.equal(await page.locator('#current-provider').innerText(), 'api');
  await page.click('#close-reset');
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis.easySwitchQuotaState;
    const template = state.providers[0];
    for (let index = 0; index < 20; index++) state.providers.push({ ...template, alias: 'extra-' + index });
    BrowserWindow.getAllWindows()[0].webContents.send('easy-switch:changed');
  });
  const last = page.locator('.provider[data-alias="extra-19"]');
  await last.waitFor(); await last.scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.provider').count(), 24);
  assert.equal(await page.locator('main').evaluate(element => element.scrollTop > 0), true, 'many accounts remain accessible by scrolling');
  assert.equal(await page.locator('.provider .tag').count(), 0);
  assert.equal(await page.locator('.provider[data-alias="api"] .select-provider').getAttribute('aria-pressed'), 'true');
});
test('Electron recovery helper restores both clients after the main process is killed', { skip: !enabled,timeout:30000 }, async t => {
  const { app,page,file,original,root,options } = await launch(t);
  await page.evaluate(async () => { await window.easySwitch.call('client', 'claude'); await window.easySwitch.call('add-api', { alias: 'claude-api', key: 'fixture' }); });
  const claudeFile = path.join(options.env.CLAUDE_CONFIG_DIR, 'settings.json'); assert.ok(fs.existsSync(claudeFile));
  const desktopFile = path.join(options.env.SWITCH_CLAUDE_DESKTOP_HOME, 'Claude', 'claude_desktop_config.json'); assert.equal(JSON.parse(fs.readFileSync(desktopFile)).deploymentMode, '3p');
  const child = app.process(); const exit = once(child,'exit'); child.kill('SIGKILL'); await exit;
  for (let attempt=0; attempt<100 && fs.existsSync(path.join(root,'desktop-session.json')); attempt++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(fs.existsSync(path.join(root,'desktop-session.json')),false);
  for (let attempt = 0; attempt < 100 && fs.existsSync(path.join(root, 'claude-session.json')); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(claudeFile), false);
  for (let attempt = 0; attempt < 100 && fs.existsSync(path.join(root, 'claude-desktop-session.json')); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(desktopFile), false);
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
 const animation = await page.evaluate(() => {
  const alpha = document.querySelector('[data-alias="alpha"]'), gamma = document.querySelector('[data-alias="gamma"]');
  const before = alpha.getBoundingClientRect().top, transfer = new DataTransfer();
  gamma.querySelector('.drag-handle').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
  alpha.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: before + 3 }));
  const motion = alpha.getAnimations()[0], atStart = alpha.getBoundingClientRect().top;
  motion.pause(); motion.currentTime = 130;
  const atMiddle = alpha.getBoundingClientRect().top;
  motion.finish();
  const atEnd = alpha.getBoundingClientRect().top;
  gamma.querySelector('.drag-handle').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  return { before, atStart, atMiddle, atEnd };
 });
 assert.ok(Math.abs(animation.atStart - animation.before) < 1, 'the displaced provider starts at its previous visual position');
 assert.ok(animation.atMiddle > animation.atStart && animation.atMiddle < animation.atEnd, 'the provider slides through intermediate positions');
 await page.evaluate(() => Promise.all([...document.querySelectorAll('.provider')].flatMap(row => row.getAnimations().map(animation => animation.finished))));
 await page.evaluate(() => { const main = document.querySelector('main'); main.scrollTop = main.scrollHeight; });
 await page.locator('.provider[data-alias="gamma"] .drag-handle').dragTo(page.locator('.provider[data-alias="alpha"]'), { targetPosition: { x: 100, y: 4 } });
 await page.waitForFunction(()=>document.querySelector('.provider')?.dataset.alias==='gamma');
 assert.deepEqual((await page.evaluate(() => window.easySwitch.call('state'))).providers.map(provider => provider.alias), ['gamma','alpha','beta']);
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

test('API import previews its type, close icons center, and model refresh confirms success without network controls', {skip:!enabled,timeout:60000}, async t => {
  const upstream = http.createServer((_req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{id:'gpt-6.1-sol'},{id:'relay-model'}]})); }).listen(0,'127.0.0.1'); await once(upstream,'listening');t.after(()=>upstream.close());
  const original=`model_provider="relay"\n[model_providers.relay]\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nexperimental_bearer_token="fixture-import-secret"\n`;
  const {page}=await launch(t,{},original);
  const centered=async id=>{const button=await page.locator('#'+id).boundingBox(),glyph=await page.locator('#'+id+' svg').boundingBox(); assert.ok(Math.abs(button.x+button.width/2-glyph.x-glyph.width/2)<1);assert.ok(Math.abs(button.y+button.height/2-glyph.y-glyph.height/2)<1);};
  await page.click('#import-existing');await page.locator('#import-preview').filter({hasText:'Detected API provider'}).waitFor();
  assert.equal(await page.locator('#provider-alias').inputValue(),'relay');await centered('close-dialog');
  assert.equal((await page.locator('#import-preview').innerText()).includes('fixture-import-secret'),false);
  await page.click('#save-provider');await page.locator('.provider strong').filter({hasText:'relay'}).waitFor();
  await page.locator('.query-models').click(); await centered('close-models');
  await page.locator('#models-status').filter({ hasText: 'Catalog refreshed · 2 models' }).waitFor();
  await page.click('#models-refresh'); await page.locator('#models-refresh:not([disabled])').waitFor();
  assert.match(await page.locator('#models-status').innerText(), /2 models/);
  await page.fill('#models-search', 'relay-model'); assert.equal(await page.locator('.catalog-model').count(), 1);
  const folder = path.join(project, '.desktop-test'); await page.screenshot({ path: path.join(folder, 'provider-models.png') });
  await page.click('#close-models');
  assert.equal(await page.locator('[data-tab="network"], #proxy-url, #no-proxy').count(), 0);
  await page.click('#updates');await page.locator('#update-dialog').waitFor({state:'visible'});await centered('close-update');
});

test('desktop localizes structured update notes', { skip: !enabled, timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  const folder = path.join(project, '.desktop-test'); fs.mkdirSync(folder, { recursive: true });
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
  const uiState = { running: true, providers: [], active: 'demo', version: '0.5.4', language: 'en', dark: false, theme: 'light', platform: process.platform,
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
