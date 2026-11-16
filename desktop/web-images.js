import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectImagePage, focusImageComposer, submitImageComposer, readGeneratedImage } from './web-image-page.js';

const origin = 'https://chatgpt.com';
const imageLimit = 24 * 1024 * 1024;
const allowedImage = url => {
  try { const parsed = new URL(url); return ['blob:', 'data:'].includes(parsed.protocol) ? url.startsWith('blob:' + origin + '/') || url.startsWith('data:image/')
    : parsed.protocol === 'https:' && (parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.oaiusercontent.com')); }
  catch { return false; }
};
const failure = (status, message) => Object.assign(new Error(message), { status });

export async function parseWebImageRequest({ raw, contentType, route }) {
  let body, files = [];
  if (/^multipart\/form-data/i.test(contentType)) {
    const form = await new Request(origin, { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData();
    body = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'));
    for (const [key, value] of form) if (typeof value !== 'string') {
      if (!['image', 'image[]'].includes(key)) throw failure(400, 'Web images do not support this image-edit field.');
      files.push({ type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
    }
  } else body = JSON.parse(raw.toString());
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) throw failure(400, 'Enter an image prompt of at most 16000 characters.');
  if (body.n != null && Number(body.n) !== 1) throw failure(400, 'Web image routing supports one image request at a time.');
  if (body.mask || body.markup || body.frame_count || body.svg) throw failure(400, 'Web image routing does not support masks, markup, animation or SVG controls.');
  if (body.images != null) {
    if (!Array.isArray(body.images)) throw failure(400, 'Invalid reference images.');
    for (const image of body.images) {
      const value = image?.image_url;
      const match = typeof value === 'string' && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/\r\n]+={0,2})$/.exec(value);
      if (!match) throw failure(400, 'Web image references must be inline PNG, JPEG, WebP or GIF files.');
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

export class WebImages {
  constructor({ root, BrowserWindow, session, nativeImage, enabled = () => false, network = () => ({}), changed = () => {}, now = Date.now }) {
    Object.assign(this, { root, BrowserWindow, session, nativeImage, enabled, network, changed, now });
    this.state = { phase: 'disconnected' }; this.window = null; this.pending = false; this.browser = null; this.destroyed = Promise.resolve();
    this.results = new Map();
  }
  snapshot() { return { enabled: this.enabled(), phase: this.state.phase }; }
  emit(phase) { this.state = { phase }; this.changed(); }
  browserSession() {
    if (!this.browser) {
      // Named persistent partitions stay inside Electron's sessionData directory.
      // A sibling fromPath profile can report persistent while the sandboxed
      // network process cannot write its cookie database.
      this.browser = this.session.fromPartition('persist:easy-switch-web-images', { cache: true });
      this.browser.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.browser.setPermissionCheckHandler(() => false);
    }
    return this.browser;
  }
  async flush() {
    if (!this.browser) return;
    this.browser.flushStorageData();
    await this.browser.cookies.flushStore();
  }
  async evaluate(fn, args) {
    if (!this.window || this.window.isDestroyed() || new URL(this.window.webContents.getURL()).origin !== origin) throw failure(401, 'Open Web images in easy-switch Settings and sign in to ChatGPT.');
    return this.window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${fn.toString()})(${args === undefined ? '' : JSON.stringify(args)})` }]);
  }
  async ensureWindow(show = false) {
    await this.destroyed;
    if (this.window && !this.window.isDestroyed()) { if (show) { this.window.show(); this.window.focus(); } return; }
    this.browserSession();
    const settings = this.network();
    await this.browser.setProxy(settings.httpProxy || settings.httpsProxy ? { mode: 'fixed_servers', proxyRules: `http=${settings.httpProxy || settings.httpsProxy};https=${settings.httpsProxy || settings.httpProxy}`, proxyBypassRules: (settings.noProxy || '<local>').replaceAll(',', ';') }
      : { mode: ['saved', 'environment'].includes(settings.source) ? 'direct' : 'system' });
    const window = new this.BrowserWindow({ width: 1100, height: 820, show, title: 'easy-switch · ChatGPT Images',
      webPreferences: { session: this.browser, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true } });
    this.window = window;
    const navigation = url => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };
    window.webContents.on('will-navigate', (event, url) => { if (!navigation(url)) event.preventDefault(); });
    window.webContents.setWindowOpenHandler(({ url }) => { if (navigation(url)) window.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    window.on('closed', () => { if (this.window === window) this.window = null; });
    window.webContents.on('did-finish-load', () => {
      if (this.pending) return;
      this.evaluate(inspectImagePage).then(async page => {
        if (this.window !== window || this.pending) return;
        const ready = page.composer && !page.login && !page.verification;
        if (ready) await this.flush();
        if (this.window === window && !this.pending) this.emit(ready ? 'ready' : 'signin');
      }).catch(() => { if (this.window === window && !this.pending) this.emit('signin'); });
    });
    await window.loadURL(origin + '/images/');
  }
  async connect() {
    if (!this.pending) this.emit('signin'); await this.ensureWindow(true);
    if (!this.pending) try { const page = await this.evaluate(inspectImagePage); const ready = page.composer && !page.login && !page.verification; if (ready) await this.flush(); this.emit(ready ? 'ready' : 'signin'); } catch {}
    return this.snapshot();
  }
  async disconnect() {
    if (this.pending) throw failure(409, 'Wait for the current image request before disconnecting.');
    this.browserSession();
    this.close(); await this.destroyed;
    await this.browser.clearStorageData(); await this.browser.clearCache(); this.emit('disconnected');
    this.results.clear();
    await this.flush();
  }
  close() {
    const window = this.window; this.window = null;
    if (!window || window.isDestroyed()) return;
    this.destroyed = new Promise(resolve => window.webContents.once('destroyed', resolve));
    window.destroy();
  }
  async generate(request) {
    const { signal } = request;
    const parsed = await parseWebImageRequest(request);
    if (this.pending) throw failure(409, 'A web image request is already running. Retry after it finishes.');
    this.pending = true;
    const uploadDirectory = path.join(this.root, 'web-images', 'uploads', randomUUID());
    let debugging = false, submitted = false;
    const cancelled = () => { this.window?.webContents.stop(); this.close(); };
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      signal.throwIfAborted();
      const existed = this.window && !this.window.isDestroyed();
      await this.ensureWindow();
      this.window.webContents.setBackgroundThrottling(false);
      if (existed) await this.window.loadURL(origin + '/images/');
      const deadline = this.now() + 10 * 60000;
      const startupDeadline = this.now() + 30000;
      let page;
      while (this.now() < startupDeadline) {
        signal.throwIfAborted(); page = await this.evaluate(inspectImagePage);
        if (page.verification || page.login) { this.emit('signin'); this.window.show(); throw failure(401, 'Complete the official sign-in or verification in the Web images window, then retry.'); }
        if (page.composer) break;
        await delay(500, undefined, { signal });
      }
      if (!page?.composer) throw failure(503, 'The ChatGPT web composer is unavailable. Open Web images in Settings to check it.');
      if (page.quota) { this.emit('attention'); this.window.show(); throw failure(429, 'ChatGPT web image quota is exhausted. Your text provider remains available.'); }
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
        if (current.quota) { this.emit('attention'); this.window.show(); throw failure(429, 'ChatGPT web image quota is exhausted. Your text provider remains available.'); }
        if (await this.evaluate(submitImageComposer)) { submitted = true; break; }
        await delay(500, undefined, { signal });
      }
      debuggerAPI.detach(); debugging = false;
      if (!submitted) throw failure(503, 'The ChatGPT web image request could not be submitted.');
      this.emit('generating');
      let finishedWithoutImage = 0;
      while (this.now() < deadline) {
        signal.throwIfAborted(); page = await this.evaluate(inspectImagePage);
        if (page.login || page.verification) { this.emit('signin'); this.window.show(); throw failure(401, 'Complete the official sign-in or verification in the Web images window, then retry.'); }
        const image = page.images.find(image => !prior.has(image.url) && allowedImage(image.url));
        if (image && !page.busy) {
          const encoded = await this.evaluate(readGeneratedImage, { url: image.url, limit: imageLimit });
          const bytes = Buffer.from(encoded, 'base64');
          if (!bytes.length || bytes.length > imageLimit || this.nativeImage.createFromBuffer(bytes).isEmpty()) throw failure(502, 'The generated image is invalid.');
          this.emit('ready');
          await this.flush();
          return { created: Math.floor(this.now() / 1000), data: [{ b64_json: encoded }], model: 'chatgpt-web' };
        }
        if (page.quota) { this.emit('attention'); this.window.show(); throw failure(429, 'ChatGPT web image quota is exhausted. Your text provider remains available.'); }
        finishedWithoutImage = page.assistantDone && !page.busy ? finishedWithoutImage + 1 : 0;
        if (finishedWithoutImage >= 4) { this.emit('attention'); this.window.show(); throw failure(502, 'ChatGPT completed without returning an image. Check the image window; the request is not replayed automatically.'); }
        await delay(1500, undefined, { signal });
      }
      this.emit('attention'); this.window.show();
      throw failure(504, 'No completed image was returned. Check Web images for quota, refusal or generation status; the request is not replayed automatically.');
    } finally {
      signal.removeEventListener('abort', cancelled);
      if (debugging) try { this.window?.webContents.debugger.detach(); } catch {}
      fs.rmSync(uploadDirectory, { recursive: true, force: true });
      this.pending = false;
      if (this.window && !this.window.isDestroyed()) this.window.webContents.setBackgroundThrottling(true);
      if (this.state.phase === 'ready' && this.window && !this.window.isVisible()) this.close();
      else if (this.state.phase === 'generating') this.emit('attention');
    }
  }
  async handle(request) {
    if (!this.enabled()) return null;
    for (const [key, entry] of this.results) if (entry.until <= this.now()) this.results.delete(key);
    const key = typeof request.turnId === 'string' && request.turnId.length <= 200
      ? createHash('sha256').update(request.turnId).update(request.route).update(request.raw).digest('hex') : null;
    const previous = key && this.results.get(key);
    if (previous) return Response.json(previous.body, { status: previous.status, headers: { 'x-switch-image-route': 'chatgpt-web' } });
    try {
      const body = await this.generate(request);
      if (key) this.remember(key, body, 200);
      return Response.json(body, { headers: { 'x-switch-image-route': 'chatgpt-web' } });
    }
    catch (error) {
      if (request.signal.aborted) throw error;
      const status = error.status || (error instanceof SyntaxError ? 400 : 502);
      const body = { error: { type: 'web_image_error', message: error.status ? error.message : error instanceof SyntaxError ? 'Invalid web image JSON request.' : 'Web image routing failed. Open Web images in easy-switch Settings to check the page.' } };
      if (key && ![401, 409].includes(status)) this.remember(key, body, status);
      return Response.json(body, { status, headers: { 'x-switch-image-route': 'chatgpt-web' } });
    }
  }
  remember(key, body, status) {
    this.results.set(key, { body, status, until: this.now() + (status === 200 ? 10 * 60000 : 60000) });
    while (this.results.size > 2) this.results.delete(this.results.keys().next().value);
  }
}
