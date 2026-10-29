import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkSettings } from '../src/network.js';

const execute = promisify(execFile);
export function proxyEnvironment(settings) {
  return { HTTP_PROXY: settings.httpProxy || '', http_proxy: settings.httpProxy || '',
    HTTPS_PROXY: settings.httpsProxy || '', https_proxy: settings.httpsProxy || '',
    ALL_PROXY: '', all_proxy: '', NO_PROXY: settings.noProxy || '', no_proxy: settings.noProxy || '' };
}
export function publicProxyURL(value) {
  if (!value) return '';
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.href; }
  catch { return ''; }
}
export async function detectSystemProxy({ platform = process.platform, execFileImpl = execute } = {}) {
  try {
    const options = { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true };
    if (platform === 'darwin') {
      const { stdout } = await execFileImpl('/usr/sbin/scutil', ['--proxy'], options);
      const field = name => stdout.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm'))?.[1].trim();
      const proxy = name => {
        const host = field(name + 'Proxy'), port = Number(field(name + 'Port'));
        return field(name + 'Enable') === '1' && host && port > 0 && port <= 65535
          ? `http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${port}` : '';
      };
      const bypass = stdout.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1] || '';
      return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS') || proxy('HTTP'),
        noProxy: [...bypass.matchAll(/\d+\s*:\s*(\S+)/g)].map(match => match[1]).join(','),
        source: 'macOS', unsupported: field('ProxyAutoConfigEnable') === '1' || field('ProxyAutoDiscoveryEnable') === '1' || field('SOCKSEnable') === '1' };
    }
    if (platform === 'win32') {
      const script = "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; [pscustomobject]@{enabled=$p.ProxyEnable;server=$p.ProxyServer;bypass=$p.ProxyOverride;pac=$p.AutoConfigURL} | ConvertTo-Json -Compress";
      const { stdout } = await execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
      const settings = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      let httpProxy = '', httpsProxy = '';
      if (settings.enabled === 1 && settings.server) {
        const proxy = value => value ? (/^https?:\/\//i.test(value) ? value : `http://${value}`) : '';
        if (settings.server.includes('=')) {
          const entries = Object.fromEntries(settings.server.split(';').map(item => item.trim().split('=')));
          httpProxy = proxy(entries.http); httpsProxy = proxy(entries.https) || httpProxy;
        } else httpProxy = httpsProxy = proxy(settings.server.trim());
      }
      return { httpProxy, httpsProxy, noProxy: (settings.bypass || '').split(';').filter(item => item && item !== '<local>').join(','),
        source: 'Windows', unsupported: !!settings.pac || /(?:^|;)socks=/i.test(settings.server || '') };
    }
  } catch { /* System discovery is optional; explicit settings remain available. */ }
  return { source: '', httpProxy: '', httpsProxy: '', noProxy: '' };
}

// Desktop preferences take precedence over inherited shell and system settings.
export function desktopNetworkSettings(root, env, system) {
  const hasEnv = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some(key => env[key] !== undefined);
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? '';
  const environment = { httpProxy, httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? httpProxy,
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '' };
  const detected = hasEnv ? { ...environment, source: 'environment' }
    : { ...system, noProxy: env.no_proxy ?? env.NO_PROXY ?? system.noProxy };
  const saved = fs.existsSync(path.join(root, 'network.json'));
  const settings = saved ? networkSettings(root, {}) : networkSettings(root, proxyEnvironment(detected));
  return { ...settings, source: saved ? 'saved' : detected.source || '', detected, unsupported: !!system.unsupported };
}
