import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSystemProxy, desktopNetworkSettings, publicProxyURL } from '../desktop/network.js';
import { saveNetwork } from '../src/network.js';

test('macOS HTTP/HTTPS system proxies, bypass rules and unsupported PAC are detected', async () => {
  const result = await detectSystemProxy({ platform: 'darwin', execFileImpl: async (file, args) => {
    assert.equal(file, '/usr/sbin/scutil'); assert.deepEqual(args, ['--proxy']);
    return { stdout: '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : ::1\n HTTPSPort : 7891\n ProxyAutoConfigEnable : 1\n ExceptionsList : <array> {\n 0 : *.local\n }\n}' };
  } });
  assert.equal(result.httpProxy, 'http://127.0.0.1:7890');
  assert.equal(result.httpsProxy, 'http://[::1]:7891');
  assert.equal(result.noProxy, '*.local'); assert.equal(result.unsupported, true);
});
test('Windows settings support shared and per-protocol proxies without executing user text', async () => {
  for (const server of ['localhost:7890', 'http=localhost:7890;https=localhost:7891;socks=localhost:1080']) {
    const result = await detectSystemProxy({ platform: 'win32', execFileImpl: async (_file, args) => {
      assert.ok(!args.join(' ').includes(server));
      return { stdout: JSON.stringify({ enabled: 1, server, bypass: '<local>;*.example.test', pac: '' }) };
    } });
    assert.equal(result.httpProxy, 'http://localhost:7890');
    assert.equal(result.httpsProxy, server.includes('=') ? 'http://localhost:7891' : 'http://localhost:7890');
    assert.equal(result.noProxy, '*.example.test');
  }
  const disabled = await detectSystemProxy({ platform: 'win32', execFileImpl: async () => ({ stdout: '{"enabled":0,"server":"old:7890"}' }) });
  assert.equal(disabled.httpProxy, '');
  const unavailable = await detectSystemProxy({ platform: 'darwin', execFileImpl: async () => { throw Error('unavailable'); } });
  assert.equal(unavailable.httpProxy, '');
});
test('desktop saved settings override environment and system; detection masks proxy credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-desktop-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const system = { httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890', source: 'macOS' };
  assert.equal(desktopNetworkSettings(root, {}, system).httpsProxy, system.httpsProxy);
  const environment = { HTTPS_PROXY: 'http://127.0.0.1:8888' };
  assert.equal(desktopNetworkSettings(root, environment, system).httpsProxy, environment.HTTPS_PROXY);
  saveNetwork(root, { HTTP_PROXY: '', HTTPS_PROXY: '' });
  const settings = desktopNetworkSettings(root, environment, system);
  assert.equal(settings.httpsProxy, ''); assert.equal(settings.source, 'saved');
  assert.equal(settings.detected.httpsProxy, environment.HTTPS_PROXY);
  assert.equal(desktopNetworkSettings(root, { ALL_PROXY: 'socks5://localhost:1080' }, system).httpsProxy, '');
  assert.equal(publicProxyURL('http://user:secret@127.0.0.1:7890'), 'http://127.0.0.1:7890/');
});
