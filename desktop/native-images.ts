import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpstreamFetch, type ProxySettings } from '../src/network.js';
import { failure, imageLimit, initializeImagePage, parseAccountImageRequest, savedImageSession } from './account-images.js';
import { focusImageComposer, inspectImagePage, readGeneratedImage, submitImageComposer } from './web-image-page.js';

import { browserExecutable, startBrowser } from './image-browser.js';
const origin = 'https://chatgpt.com';
interface NativeImageRequest {
  accountHome: string; contentType: string; route: string; raw: string;
}

export async function nativeAccountImage(root: string, request: NativeImageRequest, proxy: ProxySettings & { source?: string },
  { html: fixture, executable = browserExecutable }: { html?: string; executable?: () => string } = {}) {
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let submitted = false;
  let stage = 'request';
  const signal = AbortSignal.timeout(10 * 60000);
  const directory = path.join(root, 'image-uploads', randomUUID());
  try {
    const data = await parseAccountImageRequest({ ...request, raw: Buffer.from(request.raw, 'base64') });
    stage = 'account';
    const login = savedImageSession(request.accountHome);
    stage = 'page';
    let html: string;
    if (fixture) html = fixture;
    else {
      const upstream = createUpstreamFetch(root);
      try {
        const response = await upstream.fetch(origin + '/images/', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) });
        if (!response.ok) { await response.body?.cancel(); throw failure(response.status, 'The ChatGPT image page is temporarily unavailable.'); }
        html = await response.text();
        if (html.length > 4 * 1024 * 1024) throw failure(503, 'The ChatGPT image page is unavailable.');
      } finally { await upstream.close(); }
    }
    html = initializeImagePage(html, login);
    stage = 'browser';
    browser = await startBrowser(executable(), path.join(directory, 'profile'), { ...proxy, direct: ['saved', 'environment'].includes(proxy.source) });
    stage = 'authorization';
    const initial = AbortSignal.timeout(30000);
    const abort = () => void browser?.close().catch(() => {});
    initial.addEventListener('abort', abort, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    const target = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://chatgpt.com/*', requestStage: 'Request' }] });
    browser.handlers.set('Fetch.requestPaused', async ({ requestId, request }) => {
      try {
        const url = new URL(request.url);
        const page = url.origin === origin && request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/images';
        const authenticated = url.origin === origin && request.method === 'GET' && url.pathname === '/api/auth/session';
        if (page || authenticated) {
          await send('Fetch.fulfillRequest', { requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: page ? 'text/html; charset=utf-8' : 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
            body: Buffer.from(page ? html : JSON.stringify(login)).toString('base64') });
        } else if (fixture) await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        else await send('Fetch.continueRequest', { requestId });
      } catch {}
    });
    const loaded = new Promise<void>(resolve => browser.handlers.set('Page.loadEventFired', resolve));
    const { errorText } = await send('Page.navigate', { url: origin + '/images/' });
    if (errorText) throw failure(502, 'The isolated image browser could not open the image page.');
    await Promise.race([loaded, delay(2000, undefined, { signal: initial })]);
    async function evaluate<T>(fn: (...args: any[]) => T, arg?: unknown): Promise<Awaited<T>> {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const { frameTree: { frame } } = await send('Page.getFrameTree');
        if (new URL(frame.url).origin !== origin) throw failure(401, 'The saved image session is unavailable.');
        try {
          // The official page may reload after account initialization. Obtain
          // the current document's world instead of retaining a stale context.
          const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'fluid-images' });
          const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
            contextId: executionContextId, awaitPromise: true, returnByValue: true });
          if (result.exceptionDetails) throw failure(502, 'The image browser could not complete an operation.');
          return result.result.value;
        } catch (error) {
          // A click must never be replayed after an uncertain submission.
          if (error.navigation && fn === submitImageComposer) submitted = true;
          if (!error.navigation || fn === submitImageComposer || attempt >= 2) throw error;
          await delay(100, undefined, { signal });
        }
      }
    }
    let page: ReturnType<typeof inspectImagePage>;
    do {
      initial.throwIfAborted();
      page = await evaluate(inspectImagePage);
      if (page.verification || page.login) throw failure(page.verification ? 403 : 401, 'The saved account could not authorize image generation.');
      if (!page.composer) await delay(500, undefined, { signal: initial });
    } while (!page.composer);
    if (page.quota) throw failure(429, 'ChatGPT account image quota is exhausted.');
    initial.removeEventListener('abort', abort);
    stage = 'composer';
    const prior = new Set(page.images.map(image => image.url));
    if (data.files.length) {
      const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
      const files = data.files.map((file, index) => {
        const name = path.join(directory, `reference-${index}.${types[file.type]}`);
        fs.writeFileSync(name, file.bytes, { mode: 0o600 });
        return name;
      });
      const { root: document } = await send('DOM.getDocument');
      let { nodeId } = await send('DOM.querySelector', { nodeId: document.nodeId, selector: 'input[type="file"][multiple][accept*="image"]' });
      if (!nodeId) ({ nodeId } = await send('DOM.querySelector', { nodeId: document.nodeId, selector: 'input[type="file"][multiple], input[type="file"][accept*="image"]' }));
      if (!nodeId) throw failure(503, 'The ChatGPT image upload control is unavailable.');
      await send('DOM.setFileInputFiles', { nodeId, files });
    }
    if (!await evaluate(focusImageComposer)) throw failure(503, 'The ChatGPT web composer changed.');
    await send('Input.insertText', { text: data.prompt });
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      if ((await evaluate(inspectImagePage)).quota) throw failure(429, 'ChatGPT account image quota is exhausted.');
      if (await evaluate(submitImageComposer)) { submitted = true; break; }
      await delay(500, undefined, { signal });
    }
    if (!submitted) throw failure(503, 'The ChatGPT account image request could not be submitted.');
    stage = 'generation';
    while (!signal.aborted) {
      page = await evaluate(inspectImagePage);
      if (page.login || page.verification) throw failure(401, 'The saved account image authorization changed.');
      const found = page.images.find(image => {
        if (prior.has(image.url)) return false;
        const url = new URL(image.url);
        return image.url.startsWith('blob:' + origin + '/') || image.url.startsWith('data:image/')
          || url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.oaiusercontent.com'));
      });
      if (found && !page.busy) {
        const encoded = await evaluate(readGeneratedImage, { url: found.url, limit: imageLimit });
        if (!encoded || encoded.length > Math.ceil(imageLimit / 3) * 4) throw failure(502, 'The generated image is invalid.');
        return { status: 200, submitted, body: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: encoded }], model: 'chatgpt-account' } };
      }
      if (page.quota) throw failure(429, 'ChatGPT account image quota is exhausted.');
      await delay(1500, undefined, { signal });
    }
    throw failure(502, 'The submitted image request did not return an image.');
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : signal.aborted ? 504 : 502);
    return { status, submitted: submitted && ![401, 403, 429].includes(status), body: { error: { type: 'account_image_error',
      stage, message: error.status ? error.message : `Account image routing failed at ${stage}. Your text provider remains available.` } } };
  } finally {
    await browser?.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
