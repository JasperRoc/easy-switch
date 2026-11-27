import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountImageRequest, accountImageSession, initializeImagePage } from '../desktop/account-images.js';

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

test('Windows image browser discovery includes system Edge with missing ProgramFiles environment', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { browserExecutable } = await import('../desktop/image-browser.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-image-browser-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const edge = path.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'); fs.mkdirSync(path.dirname(edge), { recursive: true }); fs.writeFileSync(edge, 'fixture');
  assert.equal(browserExecutable({ platform: 'win32', userHome: directory, env: { ProgramW6432: directory, LOCALAPPDATA: directory } }), edge);
});

test('image browser does not inherit Windows app-health compatibility flags', async t => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { startBrowser } = await import('../desktop/image-browser.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-browser-environment-'));
  const previous = process.env.__COMPAT_LAYER;
  process.env.__COMPAT_LAYER = 'DetectorsAppHealth';
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.__COMPAT_LAYER; else process.env.__COMPAT_LAYER = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let inherited;
  t.mock.method(childProcess, 'spawn', (_command, _flags, options) => {
    inherited = options.env;
    return Object.assign(new EventEmitter(), { exitCode: 0, stdio: [null, null, null, new PassThrough(), new PassThrough()] });
  });
  syncBuiltinESMExports();
  const browser = await startBrowser('fixture-browser', directory, {});
  await browser.close();
  assert.ok(inherited);
  assert.equal(Object.keys(inherited).some(key => key.toUpperCase() === '__COMPAT_LAYER'), false);
  assert.deepEqual(inherited, Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== '__COMPAT_LAYER')));
  assert.equal(process.env.__COMPAT_LAYER, 'DetectorsAppHealth');
});
