import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeAccountImage } from '../desktop/native-images.js';
import { browserExecutable, startBrowser } from '../desktop/image-browser.js';
import { inspectImagePage } from '../desktop/web-image-page.js';

const requested = process.env.SWITCH_TEST_IMAGE_BROWSER;

for (const modern of [false, true]) test('isolated image browser handles ' + (modern ? 'contenteditable' : 'textarea') + ', references and quota', { skip: !requested, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-image-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const accountHome = path.join(root, 'account');
  fs.mkdirSync(accountHome);
  const claims = { exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', user_id: 'fixture', chatgpt_plan_type: 'free' } };
  const access_token = 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
  fs.writeFileSync(path.join(accountHome, 'auth.json'), JSON.stringify({ tokens: { access_token, account_id: 'fixture' } }));
  const original = fs.readFileSync(new URL('../desktop/assets/icon.png', import.meta.url), 'base64');
  const image = 'data:image/png;base64,' + original;
  for (const mode of ['image', 'edit', 'quota', 'prequota', ...(modern ? ['delayed', 'async', 'reload', 'usagequota', 'tombstonequota'] : [])]) {
    const composer = modern ? '<div role="textbox" contenteditable="true"></div>' : '<textarea id="mobile-composer-prompt"></textarea>';
    const html = '<!doctype html><style>[role="textbox"]{min-height:40px;width:400px}</style>' +
      '<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null}</script>' +
      '<input type="file" accept="image/*" capture="environment"><input type="file" accept="image/*" multiple>' +
      composer + '<button ' + (modern ? 'aria-label="发送"' : 'data-testid="send-button"') + ' disabled>Send</button>' +
      (mode === 'prequota' ? '<small>还可生成 0 张图像。请等待用量重置。</small>' : '') +
      '<main></main><script>(' + function (modern, mode, image) {
        const saved = JSON.parse(document.querySelector('#client-bootstrap').textContent);
        if (saved.authStatus !== 'logged_in' || saved.session.account.id !== 'fixture') throw new Error('Missing identity');
        const input = document.querySelector('textarea,[role="textbox"]'), send = document.querySelector('button');
        if (mode === 'reload' && !sessionStorage.getItem('reloaded')) {
          input.style.display = 'none'; sessionStorage.setItem('reloaded', '1');
          setTimeout(() => location.reload(), 1000);
        }
        input.addEventListener('input', () => { send.disabled = !(input.value || input.textContent); });
        send.addEventListener('click', () => {
          const box = document.createElement('div');
          if (modern) box.dataset.responseBody = 'response-fixture';
          else box.dataset.messageAuthorRole = 'assistant';
          if (mode === 'tombstonequota') { const notice = document.createElement('div'); notice.dataset.testid = 'image-gen-rate-limit-tombstone'; notice.textContent = 'Please wait until your usage resets.'; document.querySelector('main').append(notice); }
          else if (mode === 'usagequota') box.textContent = 'There’s not enough usage available on your plan to create images right now, but more will be available after 3:55 PM.';
          else if (mode === 'quota') box.textContent = 'You have reached your image generation limit.';
          else if (mode === 'edit' && document.querySelector('input[multiple]').files.length !== 1) box.textContent = 'Missing reference image';
          else if (mode === 'async') {
            box.textContent = 'Your image is being prepared.';
            setTimeout(() => { const img = document.createElement('img'); img.src = image; box.append(img); }, 10000);
          } else if (mode === 'delayed') {
            // The assistant stream ends before the asynchronous image is ready.
            // Current pages need not wrap the result in generated-image-preview.
            box.textContent = 'Generating image… 37%';
            const progress = document.createElement('div'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuenow', '37');
            progress.style.cssText = 'width:200px;height:10px'; box.append(progress);
            const img = document.createElement('img'); img.src = image; box.append(img);
            setTimeout(() => progress.remove(), 10000);
          } else {
            const preview = document.createElement('button'); preview.dataset.testid = 'generated-image-preview';
            const img = document.createElement('img'); img.src = image; preview.append(img); box.append(preview);
          }
          document.querySelector('main').append(box);
        });
      } + ')(' + [modern, mode, image].map(value => JSON.stringify(value)).join(',') + ')</script>';
    const raw = Buffer.from(JSON.stringify({ prompt: 'A blue square', ...(mode === 'edit' ? { images: [{ image_url: image }] } : {}) })).toString('base64');
    const route = '/v1/images/' + (mode === 'edit' ? 'edits' : 'generations');
    const started = Date.now();
    const result = await nativeAccountImage(root, { accountHome, contentType: 'application/json', raw, route }, { source: 'saved' },
      { html, executable: requested === '1' ? () => browserExecutable() : () => requested });
    assert.equal(result.status, ['image', 'edit', 'delayed', 'async', 'reload'].includes(mode) ? 200 : 429, result.body.error?.message);
    if (['usagequota', 'tombstonequota'].includes(mode)) {
      assert.ok(Date.now() - started < 10000, 'quota notice returns without waiting for the generation timeout');
      assert.equal(result.submitted, false, 'a definite quota rejection permits another image provider');
    }
    if (result.status === 200) assert.equal(result.body.data[0].b64_json, original);
    if (['delayed', 'async'].includes(mode)) assert.ok(Date.now() - started >= 10000, 'waits for the final image after the text stream ends');
    assert.deepEqual(fs.readdirSync(path.join(root, 'image-uploads')), []);
  }
  assert.equal(fs.existsSync(path.join(root, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'config.toml')), false);
});

test('image quota notices are detected without treating prompts or hidden notices as quota failures', { skip: !requested, timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-image-page-quota-'));
  const browser = await startBrowser(requested === '1' ? browserExecutable() : requested, path.join(root, 'profile'), {});
  t.after(async () => { await browser.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send('Page.enable');
  const inspect = async html => {
    const { frameTree: { frame } } = await send('Page.getFrameTree');
    await send('Page.setDocumentContent', { frameId: frame.id, html });
    const { result } = await send('Runtime.evaluate', { expression: `(${inspectImagePage.toString()})()`, returnByValue: true });
    return result.value;
  };
  const composer = '<div><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></div>';
  for (const text of [
    'There’s not enough usage available on your plan to create images right now.',
    "You're out of images",
    'You’re out of images',
    "You've used all your free images for now.",
    '当前图像用量不足，请等待恢复。',
    '还可生成 ⁨0⁩ 张图像。',
  ]) {
    assert.equal((await inspect(composer + '<div data-message-author-role="assistant">' + text + '</div>')).quota, true, text);
  }
  assert.equal((await inspect(composer + '<div data-testid="image-gen-rate-limit-tombstone">Please wait.</div>')).quota, true);
  assert.equal((await inspect(composer + '<div data-testid="image-gen-rate-limit-tombstone" hidden>You’re out of images.</div>')).quota, false);
  assert.equal((await inspect('<main><div data-message-author-role="user">You’re out of images</div>' + composer + '</main>')).quota, false);
  assert.equal((await inspect('<div><textarea id="prompt-textarea">There’s not enough usage available on your plan to create images right now.</textarea><button>Send</button></div>')).quota, false);
  assert.equal((await inspect(composer + '<div data-message-author-role="assistant">Your image is being prepared.</div>')).quota, false);
});
