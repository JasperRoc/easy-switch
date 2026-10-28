import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { networkSettings, saveNetwork, networkEnvironment, createUpstreamFetch } from '../src/network.js';
import { init, addProvider, atomic } from '../src/store.js';
import { createProxy } from '../src/proxy.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function upstreamAndProxy(t) {
  const received = [], tunnels = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ url: req.url, authorization: req.headers.authorization, proxyAuthorization: req.headers['proxy-authorization'], body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"text":"via tunnel"}\n\n');
  }));
  const server = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
  server.on('connect', (req, socket, head) => {
    tunnels.push({ authority: req.url, authorization: req.headers['proxy-authorization'] });
    const target = net.connect(new URL(upstream).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy());
    socket.on('close', () => target.destroy());
  });
  return { upstream, proxy: await listen(t, server), received, tunnels };
}

test('proxy settings persist privately and load without shell environment', t => {
  const root = fixture(t);
  saveNetwork(root, { HTTPS_PROXY: 'http://user:password@127.0.0.1:20000', NO_PROXY: 'internal.example' });
  const settings = networkSettings(root, {});
  assert.equal(settings.httpsProxy, 'http://user:password@127.0.0.1:20000');
  assert.ok(settings.noProxy.includes('internal.example'));
  assert.ok(settings.noProxy.includes('127.0.0.1'));
  assert.deepEqual(networkSettings(root, { https_proxy: 'http://127.0.0.1:20001', HTTPS_PROXY: 'http://ignored:1234' }).httpsProxy, 'http://127.0.0.1:20001');
  assert.equal(networkSettings(root, { HTTPS_PROXY: '' }).httpsProxy, '');
  assert.equal(networkSettings(root, { ALL_PROXY: 'http://127.0.0.1:20002' }).httpProxy, 'http://127.0.0.1:20002');
  assert.equal(networkSettings(root, { NO_PROXY: '*' }).noProxy, '*');
  const env = networkEnvironment(root, { PATH: '/bin' });
  assert.equal(env.HTTPS_PROXY, settings.httpsProxy); assert.equal(env.https_proxy, settings.httpsProxy);
  assert.equal(env.PATH, '/bin');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'network.json')).mode & 0o777, 0o600);
  assert.throws(() => networkSettings(root, { HTTPS_PROXY: 'socks5://secret:password@localhost:1080' }), error => !error.message.includes('password'));
});

test('explicit HTTP proxy tunnels SSE, bypasses loopback, and separates proxy credentials', async t => {
  const root = fixture(t);
  const { upstream, proxy, received, tunnels } = await upstreamAndProxy(t);
  const authenticatedProxy = proxy.replace('://', '://proxy-user:proxy-password@');
  const client = createUpstreamFetch(root, { HTTP_PROXY: authenticatedProxy });
  t.after(() => client.close());
  const response = await client.fetch('http://unresolvable.invalid/v1/responses', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer upstream-only' } });
  assert.match(await response.text(), /via tunnel/);
  assert.equal(tunnels[0].authority, 'unresolvable.invalid:80');
  assert.match(tunnels[0].authorization, /^Basic /);
  assert.equal(received[0].authorization, 'Bearer upstream-only');
  assert.equal(received[0].proxyAuthorization, undefined);
  const local = await client.fetch(upstream + '/health'); await local.text();
  assert.equal(tunnels.length, 1); // Loopback never enters the outbound proxy.
  assert.equal(received[1].url, '/health');
});

test('saved proxy handles subscription HTTPS SSE without Content-Type or shell proxy variables', async t => {
  const root = fixture(t);
  if (spawnSync('openssl', ['version']).error?.code === 'ENOENT') return t.skip('OpenSSL is required for this TLS integration test');
  const key = path.join(root, 'test.key'), cert = path.join(root, 'test.crt');
  const config = path.join(root, 'openssl.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=chatgpt.com\n[ext]\nsubjectAltName=DNS:chatgpt.com\nbasicConstraints=critical,CA:TRUE\n');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  let received;
  const upstream = await listen(t, https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200); res.end('data: {"text":"subscription via TLS"}\n\n');
  }));
  const authorities = [];
  const proxyServer = http.createServer();
  proxyServer.on('connect', (req, socket, head) => {
    authorities.push(req.url);
    const target = net.connect(new URL(upstream).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy()); socket.on('close', () => target.destroy());
  });
  const proxy = await listen(t, proxyServer);
  saveNetwork(root, { HTTPS_PROXY: proxy });
  const { token } = init(root);
  const accountHome = path.join(root, 'accounts', 'mock');
  atomic(path.join(accountHome, 'auth.json'), { tokens: { access_token: 'mock-only', account_id: 'mock-account' } });
  addProvider('account', { type: 'account', accountHome }, root);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete env[key];
  const script = `
    import { createProxy } from ${JSON.stringify(new URL('../src/proxy.js', import.meta.url).href)};
    import { once } from 'node:events';
    const server = createProxy({ root: ${JSON.stringify(root)} });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/responses', {
        method: 'POST', headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)}, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock', input: 'hello' }), signal: AbortSignal.timeout(10000),
      });
      console.log(JSON.stringify({ status: response.status, body: await response.text() }));
    } finally { server.closeAllConnections(); server.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  const response = JSON.parse(output);
  assert.equal(response.status, 200, response.body);
  assert.match(response.body, /subscription via TLS/);
  assert.deepEqual(authorities, ['chatgpt.com:443']);
  assert.equal(received.url, '/backend-api/codex/responses');
  assert.equal(received.headers.authorization, 'Bearer mock-only');
  assert.equal(received.body.input, 'hello');
});

test('unreachable outbound proxy fails without retrying directly', async t => {
  const root = fixture(t);
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const client = createUpstreamFetch(root, { HTTPS_PROXY: `http://127.0.0.1:${port}` });
  t.after(() => client.close());
  await assert.rejects(client.fetch('https://upstream.invalid/responses', { signal: AbortSignal.timeout(3000) }));
});


test('NO_PROXY bypasses the outbound tunnel for configured domains', async t => {
  const root = fixture(t);
  const { proxy, tunnels } = await upstreamAndProxy(t);
  const client = createUpstreamFetch(root, { HTTPS_PROXY: proxy, NO_PROXY: '.invalid' });
  t.after(() => client.close());
  await assert.rejects(client.fetch('https://unresolvable.invalid/responses', { signal: AbortSignal.timeout(2000) }));
  assert.equal(tunnels.length, 0);
});
