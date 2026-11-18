import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AccountImages, parseAccountImageRequest, accountImageSession, initializeImagePage } from '../desktop/account-images.js';
import { atomic } from '../src/store.js';

function login({ account = 'account', user = 'person', plan = 'free', expired = false } = {}) {
  return { tokens: { account_id: 'account', access_token: 'fixture.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + (expired ? -60 : 3600),
    'https://api.openai.com/auth': { chatgpt_account_id: account, user_id: user, chatgpt_account_user_id: 'account-user', chatgpt_plan_type: plan },
    'https://api.openai.com/profile': { name: 'Example', email: 'person@example.invalid' } })).toString('base64url') + '.fixture' } };
}
const shell = '<!doctype html><script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null,"extra":"keep"}</script>';
const request = (provider, body = { prompt: 'draw a bird' }) => ({ provider, raw: Buffer.from(JSON.stringify(body)), contentType: 'application/json', route: '/v1/images/generations', signal: new AbortController().signal });

test('image page initialization reuses the real saved identity and plan without granting server permission', () => {
  for (const plan of ['free', 'plus', 'prolite']) {
    const auth = login({ plan }), session = accountImageSession(auth);
    assert.equal(session.accessToken, auth.tokens.access_token); assert.equal(session.account.planType, plan); assert.equal(session.account.id, 'account');
    const html = initializeImagePage(shell, session), result = JSON.parse(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
    assert.equal(result.authStatus, 'logged_in'); assert.equal(result.extra, 'keep'); assert.deepEqual(result.session, session);
  }
  const hostile = accountImageSession(login()); hostile.user.name = '</script>\u2028';
  const encoded = initializeImagePage(shell, hostile); assert.equal(encoded.split('</script>').length, 2); assert.match(encoded, /\\u003c\/script>/);
  assert.throws(() => accountImageSession(login({ account: 'other' })), error => error.status === 401);
  assert.throws(() => accountImageSession(login({ expired: true })), error => error.status === 401);
  assert.throws(() => initializeImagePage('<html>changed</html>', {}), error => error.status === 503);
});

test('account image requests preserve prompts and reference bytes while rejecting unsupported edits', async () => {
  const image = 'data:image/png;base64,aW1hZ2U=';
  const parsed = await parseAccountImageRequest({ ...request(null, { prompt: 'draw a bird', images: [{ image_url: image }], background: 'transparent' }), route: '/v1/images/edits' });
  assert.match(parsed.prompt, /draw a bird/); assert.match(parsed.prompt, /transparent/); assert.equal(parsed.files[0].bytes.toString(), 'image');
  const form = new FormData(); form.set('prompt', 'edit this'); form.append('image', new Blob(['reference'], { type: 'image/png' }), 'ref.png');
  const encoded = new Response(form);
  const multipart = await parseAccountImageRequest({ raw: Buffer.from(await encoded.arrayBuffer()), contentType: encoded.headers.get('content-type'), route: '/v1/images/edits' });
  assert.equal(multipart.files[0].bytes.toString(), 'reference');
  for (const body of [{ prompt: '' }, { prompt: 'x', n: 2 }, { prompt: 'x', mask: 'value' }, { prompt: 'x', images: [{ image_url: 'https://private.example/secret' }] }])
    await assert.rejects(parseAccountImageRequest(request(null, body)), error => error.status === 400);
  await assert.rejects(parseAccountImageRequest({ ...request(), route: '/v1/images/edits' }), /reference/);
});

function fixture(t, { mode = 'image' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-account-image-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = { type: 'account', accountHome: path.join(root, 'account') }; atomic(path.join(provider.accountHome, 'auth.json'), login());
  const windows = [], sessions = [], commands = [], browsers = []; let submitted = false, clock = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      this.webContents = new EventEmitter(); Object.assign(this.webContents, {
        setWindowOpenHandler() {}, setBackgroundThrottling() {}, getURL: () => this.url, stop() {},
        debugger: { attach() {}, detach() {}, async sendCommand(method, params) { commands.push({ method, params }); return method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { nodeId: 2 }; } },
        executeJavaScriptInIsolatedWorld: async (_id, [{ code }]) => {
          if (code.includes('function inspectImagePage')) return { composer: true, login: mode === 'login', verification: false, busy: false, quota: mode === 'quota',
            images: submitted && mode === 'image' ? [{ url: 'https://chatgpt.com/backend-api/files/file/download', width: 1024, height: 1024 }] : [] };
          if (code.includes('function focusImageComposer')) return true;
          if (code.includes('function submitImageComposer')) { submitted = true; return true; }
          if (code.includes('function readGeneratedImage')) return Buffer.from('fixture-image').toString('base64');
          throw Error('Unexpected page operation');
        },
      });
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
  }
  const session = { fromPartition(partition) {
    sessions.push(partition); const browser = { async setProxy(settings) { this.proxy = settings; }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
      protocol: { async handle(_scheme, handler) { browser.handler = handler; }, async unhandle() { browser.unhandled = true; } },
      fetch: async () => Response.json({ upstream: true }), async clearStorageData() { this.cleared = true; }, async clearCache() { this.cacheCleared = true; } };
    browsers.push(browser); return browser;
  } };
  const adapter = new AccountImages({ root, BrowserWindow: Window, session, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    network: () => ({ httpsProxy: 'http://127.0.0.1:7890' }), fetchImpl: async () => new Response(shell), now: () => clock += 1000 });
  t.after(async () => { adapter.close(); await adapter.destroyed; });
  return { adapter, provider, root, windows, sessions, commands, browsers };
}

test('account images work without cookies, persistent profiles, visible windows or a public login API', async t => {
  const { adapter, provider, windows, sessions, browsers, root, commands } = fixture(t);
  const response = await adapter.handle(request(provider));
  assert.equal(response.status, 200); assert.equal((await response.json()).data[0].b64_json, Buffer.from('fixture-image').toString('base64'));
  assert.equal(response.headers.get('x-switch-image-route'), 'chatgpt-account');
  assert.ok(sessions.every(value => !value.startsWith('persist:'))); assert.equal(windows[0].options.show, false);
  assert.equal(adapter.window, null); assert.equal(adapter.browser, null); assert.equal(browsers[0].cleared, true); assert.equal(browsers[0].unhandled, true);
  assert.match(browsers[0].proxy.proxyRules, /7890/); assert.match(commands.find(c => c.method === 'Input.insertText').params.text, /draw a bird/);
  for (const method of ['connect', 'disconnect', 'snapshot']) assert.equal(adapter[method], undefined);
  assert.equal(fs.existsSync(path.join(root, 'auth.json')), false); assert.equal(fs.existsSync(path.join(root, 'config.toml')), false);
});

test('the authentication bridge serves credentials only to the exact ChatGPT session and image document', async t => {
  const { adapter, provider, browsers } = fixture(t);
  await adapter.ensureWindow(provider, new AbortController().signal);
  const session = await browsers[0].handler(new Request('https://chatgpt.com/api/auth/session'));
  assert.equal((await session.json()).account.id, 'account');
  const html = await browsers[0].handler(new Request('https://chatgpt.com/images/'));
  assert.match(await html.text(), /logged_in/);
  for (const url of ['https://private.example/api/auth/session', 'https://chatgpt.com.evil.test/api/auth/session', 'https://chatgpt.com/api/auth/session/other']) {
    const response = await browsers[0].handler(new Request(url)); assert.deepEqual(await response.json(), { upstream: true });
  }
});

test('expired page sign-in and zero image quota remain tool errors with no login window', async t => {
  for (const [mode, status] of [['login', 401], ['quota', 429]]) {
    const { adapter, provider, windows, commands } = fixture(t, { mode });
    const response = await adapter.handle(request(provider)); assert.equal(response.status, status);
    assert.equal(windows[0].options.show, false); assert.equal(adapter.window, null); assert.equal(commands.length, 0);
  }
});

test('cancellation destroys the isolated account page and removes temporary uploads', async t => {
  const { adapter, provider, root } = fixture(t), abort = new AbortController();
  const pending = adapter.handle({ ...request(provider, { prompt: 'edit', images: [{ image_url: 'data:image/png;base64,aW1hZ2U=' }] }), signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(adapter.pending, false); assert.equal(adapter.window, null);
  const uploads = path.join(root, 'image-uploads'); assert.ok(!fs.existsSync(uploads) || fs.readdirSync(uploads).length === 0);
});

test('native retries reuse completed image results and keep caches separate between saved accounts', async t => {
  const { adapter, provider } = fixture(t); let calls = 0;
  adapter.generate = async () => { calls++; return { data: [{ b64_json: 'fixture' }] }; };
  const first = { ...request(provider), turnId: 'turn' };
  assert.equal((await adapter.handle(first)).status, 200); assert.equal((await adapter.handle(first)).status, 200); assert.equal(calls, 1);
  await adapter.handle({ ...first, provider: { type: 'account', accountHome: 'other' } }); assert.equal(calls, 2);
  adapter.generate = async () => { calls++; throw Object.assign(Error('Uncertain completion'), { submitted: true }); };
  const uncertain = { ...first, turnId: 'uncertain' };
  assert.equal((await adapter.handle(uncertain)).headers.get('x-switch-image-submitted'), '1');
  assert.equal((await adapter.handle(uncertain)).headers.get('x-switch-image-submitted'), '1'); assert.equal(calls, 3);
  assert.equal(await adapter.handle(request({ type: 'api' })), null);
});
