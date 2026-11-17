if (process.versions.electron) {
  const { app, BrowserWindow, session, nativeImage } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const root = process.env.SWITCH_WEB_IMAGE_TEST_ROOT;
  app.setPath('userData', path.join(root, 'ui'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const { WebImages } = await import(pathToFileURL(path.resolve(__dirname, '../../desktop/web-images.js')).href);
    const browser = session.fromPartition('persist:easy-switch-web-images');
    const action = process.env.SWITCH_WEB_IMAGE_PERSIST_ACTION;
    if (action) {
      const adapter = new WebImages({ root, BrowserWindow, session, nativeImage });
      adapter.browserSession();
      if (action === 'write') await browser.cookies.set({ url: 'https://example.invalid', name: 'fixture-login', value: 'fixture-only', expirationDate: Date.now() / 1000 + 86400, secure: true });
      if (action === 'clear') await adapter.disconnect();
      await adapter.flush();
      const saved = (await browser.cookies.get({ url: 'https://example.invalid' })).some(cookie => cookie.name === 'fixture-login');
      console.log(JSON.stringify({ saved, persistent: browser.isPersistent(), inside: browser.storagePath.startsWith(app.getPath('sessionData') + path.sep) }));
      app.quit(); return;
    }
    const image = 'data:image/png;base64,' + fs.readFileSync(path.resolve(__dirname, '../../desktop/assets/icon.png')).toString('base64');
    const modern = process.env.SWITCH_WEB_IMAGE_MODERN === '1';
    let mode = 'image';
    await browser.protocol.handle('https', () => new Response(`<!doctype html><html><head><style>[role="textbox"]{min-height:40px;width:400px;}</style></head><body>
      <div><div><input type="file" accept="image/*" capture="environment"><input type="file" accept="image/*" multiple>${modern ? '<div role="textbox" contenteditable="true"></div>' : '<textarea id="mobile-composer-prompt"></textarea>'}<button ${modern ? 'aria-label="发送"' : 'data-testid="send-button"'} disabled>Send</button><small>${mode==='prequota'?'还可生成 0 张图像。请等待用量重置。':''}</small></div></div><main></main>
      <script>
        const input=document.querySelector('textarea,[role="textbox"]'),send=document.querySelector('button');
        input.addEventListener('input',()=>send.disabled=!(input.value||input.textContent));
        send.addEventListener('click',()=>{
          const box=document.createElement('div');${modern ? "box.dataset.responseBody='response-fixture';" : "box.dataset.messageAuthorRole='assistant';"}
          if(${JSON.stringify(mode)}==='quota')box.textContent='You have reached your image generation limit.';
          else if(${JSON.stringify(mode)}==='edit'&&document.querySelector('input[type="file"][multiple]').files.length!==1)box.textContent='Missing reference image';
          else{const preview=document.createElement('button');preview.dataset.testid='generated-image-preview';const img=document.createElement('img');img.src=${JSON.stringify(image)};preview.append(img);box.append(preview);}
          document.querySelector('main').append(box);
        });
    </script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const adapter = new WebImages({ root, BrowserWindow, session, nativeImage, enabled: () => true });
    globalThis.webImageFixture = {
      async run(nextMode) {
        mode = nextMode;
        const response = await adapter.handle({ raw: Buffer.from(JSON.stringify({ prompt: 'A blue square', ...(mode === 'edit' ? { images: [{ image_url: image }] } : {}) })), contentType: 'application/json', route: '/v1/images/' + (mode === 'edit' ? 'edits' : 'generations'), signal: AbortSignal.timeout(15000) });
        const result = await response.json();
        return { status: response.status, bytes: result.data?.[0]?.b64_json?.length || 0, phase: adapter.snapshot().phase, visible: BrowserWindow.getAllWindows().some(window => window.isVisible()), error: result.error?.message };
      },
      close() { adapter.close(); app.quit(); },
    };
    console.log('READY');
  }).catch(error => { console.error(error); app.exit(1); });
}
