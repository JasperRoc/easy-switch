import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { accountAuth } from '../src/store.js';
import { expired } from '../src/auth.js';
import { createUpstreamFetch } from '../src/network.js';
import { inspectImagePage, focusImageComposer, submitImageComposer, readGeneratedImage } from './web-image-page.js';

const origin = 'https://chatgpt.com';
const imageLimit = 24 * 1024 * 1024;
const allowedImage = url => {
  try { const parsed = new URL(url); return ['blob:', 'data:'].includes(parsed.protocol) ? url.startsWith('blob:' + origin + '/') || url.startsWith('data:image/')
    : parsed.protocol === 'https:' && (parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.oaiusercontent.com')); }
  catch { return false; }
};
const failure = (status, message) => Object.assign(new Error(message), { status });

export async function parseAccountImageRequest({ raw, contentType, route }) {
  let body, files = [];
  if (/^multipart\/form-data/i.test(contentType)) {
    const form = await new Request(origin, { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData();
    body = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'));
    for (const [key, value] of form) if (typeof value !== 'string') {
      if (!['image', 'image[]'].includes(key)) throw failure(400, 'Account images do not support this image-edit field.');
      files.push({ type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
    }
  } else body = JSON.parse(raw.toString());
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) throw failure(400, 'Enter an image prompt of at most 16000 characters.');
  if (body.n != null && Number(body.n) !== 1) throw failure(400, 'Account image routing supports one image request at a time.');
  if (body.mask || body.markup || body.frame_count || body.svg) throw failure(400, 'Account image routing does not support masks, markup, animation or SVG controls.');
  if (body.images != null) {
    if (!Array.isArray(body.images)) throw failure(400, 'Invalid reference images.');
    for (const image of body.images) {
      const value = image?.image_url;
      const match = typeof value === 'string' && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/\r\n]+={0,2})$/.exec(value);
      if (!match) throw failure(400, 'Account image references must be inline PNG, JPEG, WebP or GIF files.');
      files.push({ type: match[1], bytes: Buffer.from(match[2], 'base64') });
    }
  }
  if (files.length > 5 || files.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || !file.bytes.length || file.bytes.length > imageLimit))
    throw failure(400, 'Use up to five reference images, each no larger than 24 MiB.');
  if (route.endsWith('/edits') && !files.length) throw failure(400, 'An image edit needs at least one reference image.');
  const prompt = body.prompt;
  return { prompt: 'Generate an image for the following request. Return the generated image.\n\n' + prompt
    + (body.background === 'transparent' ? '\n\nUse a transparent background.' : ''), files };
}

export function accountImageSession(auth) {
  if (expired(auth)) throw failure(401, 'The saved account has expired. Sign in again from its provider row.');
  const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url'));
  const identity = claims['https://api.openai.com/auth'] || {}, profile = claims['https://api.openai.com/profile'] || {};
  if (identity.chatgpt_account_id !== auth.tokens.account_id || !(identity.user_id || identity.chatgpt_user_id))
    throw failure(401, 'The saved image account identity is unavailable. Sign in again from its provider row.');
  return { accessToken: auth.tokens.access_token,
    ...(typeof claims.exp === 'number' ? { expires: new Date(claims.exp * 1000).toISOString() } : {}),
    user: { id: identity.user_id || identity.chatgpt_user_id, name: profile.name, email: profile.email },
    account: { id: auth.tokens.account_id, userId: identity.chatgpt_account_user_id, planType: identity.chatgpt_plan_type } };
}

export function initializeImagePage(html, login) {
  let initialized = false;
  const result = html.replace(/(<script\b[^>]*\bid=["']client-bootstrap["'][^>]*>)([\s\S]*?)(<\/script>)/i, (_all, open, source, close) => {
    const data = JSON.parse(source);
    data.authStatus = 'logged_in'; data.session = login;
    initialized = true;
    return open + JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029') + close;
  });
  if (!initialized) throw failure(503, 'The ChatGPT image page changed. Saved account and API image routes remain available.');
  return result;
}

export class AccountImages {
  constructor({ root, BrowserWindow, session, nativeImage, network = () => ({}), fetchImpl, now = Date.now }) {
    Object.assign(this, { root, BrowserWindow, session, nativeImage, network, fetchImpl, now });
    this.window = null; this.pending = false; this.browser = null; this.destroyed = Promise.resolve();
    this.results = new Map(); this.shell = null;
  }
  async evaluate(fn, args) {
    if (!this.window || this.window.isDestroyed() || new URL(this.window.webContents.getURL()).origin !== origin)
      throw failure(401, 'The saved account image session is unavailable.');
    return this.window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${fn.toString()})(${args === undefined ? '' : JSON.stringify(args)})` }]);
  }
  async pageShell(signal) {
    if (this.shell?.until > this.now()) return this.shell.html;
    const outbound = this.fetchImpl ? null : createUpstreamFetch(this.root);
    try {
      const response = await (this.fetchImpl || outbound.fetch)(origin + '/images/', { headers: { accept: '*/*', 'user-agent': 'easy-switch-image-adapter' },
        credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) throw failure(response.status, 'The ChatGPT image page is temporarily unavailable.');
      const html = await response.text();
      if (html.length > 4 * 1024 * 1024 || !html.includes('client-bootstrap'))
        throw failure(503, 'The ChatGPT image page is unavailable.');
      this.shell = { html, until: this.now() + 5 * 60000 };
      return html;
    } finally { await outbound?.close(); }
  }
  async ensureWindow(provider, signal) {
    await this.destroyed; signal.throwIfAborted();
    const auth = accountAuth(provider), login = accountImageSession(auth);
    const html = initializeImagePage(await this.pageShell(signal), login);
    signal.throwIfAborted();
    const browser = this.session.fromPartition('easy-switch-account-images', { cache: false });
    this.browser = browser;
    browser.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browser.setPermissionCheckHandler(() => false);
    const settings = this.network();
    await browser.setProxy(settings.httpProxy || settings.httpsProxy ? { mode: 'fixed_servers', proxyRules: `http=${settings.httpProxy || settings.httpsProxy};https=${settings.httpsProxy || settings.httpProxy}`, proxyBypassRules: (settings.noProxy || '<local>').replaceAll(',', ';') }
      : { mode: ['saved', 'environment'].includes(settings.source) ? 'direct' : 'system' });
    await browser.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (url.origin === origin && request.method === 'GET') {
        if (url.pathname === '/api/auth/session') return Response.json(login, { headers: { 'cache-control': 'no-store' } });
        if (url.pathname.replace(/\/+$/, '') === '/images')
          return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return browser.fetch(request, { bypassCustomProtocolHandlers: true });
    });
    signal.throwIfAborted();
    const window = new this.BrowserWindow({ width: 1100, height: 820, show: false, title: 'easy-switch',
      webPreferences: { session: browser, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true } });
    this.window = window;
    window.webContents.on('will-navigate', (event, address) => {
      try { if (new URL(address).origin === origin) return; } catch {}
      event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('closed', () => { if (this.window === window) this.window = null; });
    await window.loadURL(origin + '/images/');
  }
  close() {
    const window = this.window, browser = this.browser;
    this.window = null; this.browser = null;
    const destroyed = window && !window.isDestroyed() ? new Promise(resolve => { window.webContents.once('destroyed', resolve); window.destroy(); }) : Promise.resolve();
    this.destroyed = this.destroyed.then(async () => {
      await destroyed;
      if (!browser) return;
      await browser.protocol.unhandle('https');
      await browser.clearStorageData(); await browser.clearCache();
    }).catch(() => {});
  }
  async generate(request) {
    const { provider } = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60000)]);
    const parsed = await parseAccountImageRequest(request);
    if (this.pending) throw failure(409, 'An account image request is already running. Retry after it finishes.');
    this.pending = true;
    const uploadDirectory = path.join(this.root, 'image-uploads', randomUUID());
    let debugging = false, submitted = false;
    const cancelled = () => { this.window?.webContents.stop(); this.close(); };
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      signal.throwIfAborted();
      await this.ensureWindow(provider, signal);
      this.window.webContents.setBackgroundThrottling(false);
      const deadline = this.now() + 10 * 60000;
      const startupDeadline = this.now() + 30000;
      let page;
      while (this.now() < startupDeadline) {
        signal.throwIfAborted(); page = await this.evaluate(inspectImagePage);
        if (page.verification || page.login) throw failure(page.verification ? 403 : 401, 'The saved account could not authorize image generation. Check its provider sign-in.');
        if (page.composer) break;
        await delay(500, undefined, { signal });
      }
      if (!page?.composer) throw failure(503, 'The account image composer is unavailable.');
      if (page.quota) { throw failure(429, 'ChatGPT account image quota is exhausted. Your text provider remains available.'); }
      const prior = new Set(page.images.map(image => image.url));
      const debuggerAPI = this.window.webContents.debugger;
      debuggerAPI.attach('1.3'); debugging = true;
      if (parsed.files.length) {
        fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
        const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
        const files = parsed.files.map((file, index) => { const name = path.join(uploadDirectory, `reference-${index}.${extensions[file.type]}`); fs.writeFileSync(name, file.bytes, { mode: 0o600 }); return name; });
        const { root } = await debuggerAPI.sendCommand('DOM.getDocument');
        let { nodeId } = await debuggerAPI.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"][multiple][accept*="image"]' });
        if (!nodeId) ({ nodeId } = await debuggerAPI.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: parsed.files.length > 1 ? 'input[type="file"][multiple]' : 'input[type="file"][accept*="image"], input[type="file"]' }));
        if (!nodeId) throw failure(503, 'The ChatGPT image upload control is unavailable.');
        await debuggerAPI.sendCommand('DOM.setFileInputFiles', { nodeId, files });
        await delay(1500, undefined, { signal });
      }
      if (!await this.evaluate(focusImageComposer)) throw failure(503, 'The ChatGPT web composer changed.');
      await debuggerAPI.sendCommand('Input.insertText', { text: parsed.prompt });
      for (let attempt = 0; attempt < 60; attempt++) {
        signal.throwIfAborted();
        const current = await this.evaluate(inspectImagePage);
        if (current.quota) { throw failure(429, 'ChatGPT account image quota is exhausted. Your text provider remains available.'); }
        if (await this.evaluate(submitImageComposer)) { submitted = true; break; }
        await delay(500, undefined, { signal });
      }
      debuggerAPI.detach(); debugging = false;
      if (!submitted) throw failure(503, 'The ChatGPT account image request could not be submitted.');
      let finishedWithoutImage = 0;
      while (this.now() < deadline) {
        signal.throwIfAborted(); page = await this.evaluate(inspectImagePage);
        if (page.login || page.verification) throw failure(page.verification ? 403 : 401, 'The saved account image authorization changed. Check its provider sign-in.');
        const image = page.images.find(image => !prior.has(image.url) && allowedImage(image.url));
        if (image && !page.busy) {
          const encoded = await this.evaluate(readGeneratedImage, { url: image.url, limit: imageLimit });
          const bytes = Buffer.from(encoded, 'base64');
          if (!bytes.length || bytes.length > imageLimit || this.nativeImage.createFromBuffer(bytes).isEmpty()) throw failure(502, 'The generated image is invalid.');
          return { created: Math.floor(this.now() / 1000), data: [{ b64_json: encoded }], model: 'chatgpt-account' };
        }
        if (page.quota) { throw failure(429, 'ChatGPT account image quota is exhausted. Your text provider remains available.'); }
        finishedWithoutImage = page.assistantDone && !page.busy ? finishedWithoutImage + 1 : 0;
        if (finishedWithoutImage >= 4) { throw failure(502, 'ChatGPT completed without returning an image. The request is not replayed automatically.'); }
        await delay(1500, undefined, { signal });
      }
      throw failure(504, 'No completed image was returned. The submitted image request is not replayed automatically.');
    } catch (error) {
      error.submitted = submitted && ![401, 403, 429].includes(error.status); throw error;
    } finally {
      signal.removeEventListener('abort', cancelled);
      if (debugging) try { this.window?.webContents.debugger.detach(); } catch {}
      fs.rmSync(uploadDirectory, { recursive: true, force: true });
      this.close(); await this.destroyed;
      this.pending = false;
    }
  }
  async handle(request) {
    if (request.provider?.type !== 'account') return null;
    for (const [key, entry] of this.results) if (entry.until <= this.now()) this.results.delete(key);
    const key = typeof request.turnId === 'string' && request.turnId.length <= 200
      ? createHash('sha256').update(request.provider.accountHome).update(request.turnId).update(request.route).update(request.raw).digest('hex') : null;
    const previous = key && this.results.get(key);
    if (previous) return Response.json(previous.body, { status: previous.status, headers: { 'x-switch-image-route': 'chatgpt-account', ...(previous.submitted ? { 'x-switch-image-submitted': '1' } : {}) } });
    try {
      const body = await this.generate(request);
      if (key) this.remember(key, body, 200);
      return Response.json(body, { headers: { 'x-switch-image-route': 'chatgpt-account' } });
    }
    catch (error) {
      if (request.signal.aborted) {
        if (key && error.submitted) this.remember(key, { error: { type: 'account_image_error', message: 'The previous image request was submitted; it will not be submitted again.' } }, 503, true);
        throw error;
      }
      const status = error.status || (error instanceof SyntaxError ? 400 : 502);
      const body = { error: { type: 'account_image_error', message: error.status ? error.message : error instanceof SyntaxError ? 'Invalid account image JSON request.' : 'Account image routing failed. Your text provider remains available.' } };
      if (key && ![401, 409].includes(status)) this.remember(key, body, status, !!error.submitted);
      return Response.json(body, { status, headers: { 'x-switch-image-route': 'chatgpt-account', ...(error.submitted ? { 'x-switch-image-submitted': '1' } : {}) } });
    }
  }
  remember(key, body, status, submitted = false) {
    this.results.set(key, { body, status, submitted, until: this.now() + (status === 200 ? 10 * 60000 : 60000) });
    while (this.results.size > 2) this.results.delete(this.results.keys().next().value);
  }
}
