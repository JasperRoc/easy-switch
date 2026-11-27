import type { ProxySettings } from '../src/network.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function browserExecutable({ env = process.env, platform = process.platform, userHome = os.homedir() } = {}) {
  const local = env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local');
  const roots = [...new Set([env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432, local, 'C:\\Program Files (x86)', 'C:\\Program Files'].filter(Boolean))];
  const candidates = platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(userHome, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : platform === 'linux' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'] : roots.flatMap(directory => [
    path.join(directory, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(directory, 'Google/Chrome/Application/chrome.exe'),
  ]);
  const executable = candidates.find(file => fs.existsSync(file));
  if (!executable) throw Object.assign(new Error('Install Chrome or Microsoft Edge to use the subscription’s web image fallback.'), { status: 503 });
  return executable;
}

export async function startBrowser(command: string, directory: string, proxy: ProxySettings & { direct?: boolean }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-pipe',
    '--window-size=1100,820', `--user-data-dir=${directory}`, 'about:blank'];
  if (proxy.httpProxy || proxy.httpsProxy) flags.unshift(
    `--proxy-server=http=${proxy.httpProxy || proxy.httpsProxy};https=${proxy.httpsProxy || proxy.httpProxy}`,
    `--proxy-bypass-list=${(proxy.noProxy || '').replaceAll(',', ';')}`);
  else if (proxy.direct) flags.unshift('--no-proxy-server');
  const env = { ...process.env };
  // Windows app-health compatibility flags can make the image browser exit immediately.
  for (const key of Object.keys(env)) if (key.toUpperCase() === '__COMPAT_LAYER') delete env[key];
  const child = spawn(command, flags, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writer = child.stdio[3] as import('node:stream').Writable;
  const reader = child.stdio[4] as import('node:stream').Readable;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  const handlers = new Map<string, (parameters: any) => void>();
  let id = 0, incomplete = Buffer.alloc(0), closed = false;
  const failed = () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error('The isolated image browser stopped.'));
    pending.clear();
  };
  child.once('exit', failed); child.once('error', failed);
  writer.on('error', failed); reader.on('error', failed);
  reader.on('data', bytes => {
    let offset = 0;
    let end;
    while ((end = bytes.indexOf(0, offset)) !== -1) {
      const chunk = Buffer.concat([incomplete, bytes.subarray(offset, end)]);
      incomplete = Buffer.alloc(0);
      offset = end + 1;
      let message;
      try { message = JSON.parse(chunk.toString()); } catch { failed(); return; }
      if (message.id) {
        const reply = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reply?.reject(Object.assign(new Error('The isolated image browser rejected a command.'), {
          navigation: /Cannot find context with specified id|Execution context was destroyed|Cannot find context with unique id/i.test(message.error.message || ''),
        }));
        else reply?.resolve(message.result);
      } else handlers.get(message.method)?.(message.params);
    }
    if (offset < bytes.length) incomplete = Buffer.concat([incomplete, bytes.subarray(offset)]);
    if (incomplete.length > 64 * 1024 * 1024) { child.kill(); failed(); }
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    if (closed) { reject(new Error('The isolated image browser stopped.')); return; }
    const request = ++id;
    pending.set(request, { resolve, reject });
    writer.write(JSON.stringify({ id: request, method, params, sessionId }) + '\0');
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once('close', resolve));
    void send('Browser.close').catch(() => {});
    await Promise.race([ended, delay(1200, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  };
  return { send, handlers, close };
}
