if (process.versions.electron) {
  const { app, BrowserWindow, session, nativeImage } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
  const root = process.env.SWITCH_ACCOUNT_IMAGE_TEST_ROOT;
  app.setPath('userData', path.join(root, 'ui')); app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const { AccountImages } = await import(pathToFileURL(path.resolve(__dirname, '../../desktop/account-images.js')).href);
    const modern = process.env.SWITCH_ACCOUNT_IMAGE_MODERN === '1';
    const image = 'data:image/png;base64,' + fs.readFileSync(path.resolve(__dirname, '../../desktop/assets/icon.png')).toString('base64');
    const provider = { type: 'account', accountHome: path.join(root, 'account') };
    fs.mkdirSync(provider.accountHome, { recursive: true });
    const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account', user_id: 'person', chatgpt_plan_type: 'free' } })).toString('base64url') + '.fixture';
    fs.writeFileSync(path.join(provider.accountHome, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt, account_id: 'account' } }));
    let mode = 'image'; const partitions = [];
    const shell = () => `<!doctype html><html><head><style>[role="textbox"]{min-height:40px;width:400px;}</style></head><body>
      <script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null}</script>
      <div><div><input type="file" accept="image/*" capture="environment"><input type="file" accept="image/*" multiple>${modern ? '<div role="textbox" contenteditable="true"></div>' : '<textarea id="mobile-composer-prompt"></textarea>'}<button ${modern ? 'aria-label="发送"' : 'data-testid="send-button"'} disabled>Send</button><small>${mode === 'prequota' ? '还可生成 0 张图像。请等待用量重置。' : ''}</small></div></div><main></main>
      <script>
        const saved=JSON.parse(document.querySelector('#client-bootstrap').textContent);
        if(saved.authStatus!=='logged_in'||!saved.session.accessToken)document.body.innerHTML='<button>Log in</button>';
        else{
        const input=document.querySelector('textarea,[role="textbox"]'),send=document.querySelector('button');
        input.addEventListener('input',()=>send.disabled=!(input.value||input.textContent));
        send.addEventListener('click',()=>{
          const box=document.createElement('div');${modern ? "box.dataset.responseBody='response-fixture';" : "box.dataset.messageAuthorRole='assistant';"}
          if(${JSON.stringify(mode)}==='quota')box.textContent='You have reached your image generation limit.';
          else if(${JSON.stringify(mode)}==='edit'&&document.querySelector('input[type="file"][multiple]').files.length!==1)box.textContent='Missing reference image';
          else{const preview=document.createElement('button');preview.dataset.testid='generated-image-preview';const img=document.createElement('img');img.src=${JSON.stringify(image)};preview.append(img);box.append(preview);}
          document.querySelector('main').append(box);
        });}
      </script></body></html>`;
    const adapter = new AccountImages({ root, BrowserWindow, session: { fromPartition(name, options) { partitions.push(name); return session.fromPartition(name, options); } }, nativeImage,
      network: () => ({ source: 'saved' }), fetchImpl: async () => new Response(shell()) });
    globalThis.accountImageFixture = {
      async run(nextMode) {
        mode = nextMode; adapter.shell = null;
        const response = await adapter.handle({ provider, raw: Buffer.from(JSON.stringify({ prompt: 'A blue square', ...(mode === 'edit' ? { images: [{ image_url: image }] } : {}) })),
          contentType: 'application/json', route: '/v1/images/' + (mode === 'edit' ? 'edits' : 'generations'), signal: AbortSignal.timeout(15000) });
        const result = await response.json();
        return { status: response.status, bytes: result.data?.[0]?.b64_json?.length || 0,
          visible: BrowserWindow.getAllWindows().some(window => window.isVisible()), released: adapter.window === null && adapter.browser === null,
          persistent: partitions.some(name => name.startsWith('persist:')), error: result.error?.message };
      },
    };
  }).catch(error => { console.error(error); app.exit(1); });
}
