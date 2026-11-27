import fs from 'node:fs';
import path from 'node:path';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { atomic } from './store.js';

export type UpstreamFetch = (url: string, options?: RequestInit) => Promise<Response>;
export interface ProxySettings { httpProxy?: string; httpsProxy?: string; noProxy?: string; }

const loopback = 'localhost,127.0.0.1,[::1],::1';
const value = (env, lower, upper) => env[lower] ?? env[upper];
export function networkSettings(root: string, env = process.env) {
  let saved: ProxySettings = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(root, 'network.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 network.json，请检查代理配置'); }
  const all = value(env, 'all_proxy', 'ALL_PROXY');
  const http = value(env, 'http_proxy', 'HTTP_PROXY');
  const httpProxy = http ?? all ?? saved.httpProxy ?? '';
  const httpsProxy = value(env, 'https_proxy', 'HTTPS_PROXY') ?? all ?? (http !== undefined ? httpProxy : saved.httpsProxy ?? httpProxy);
  let noProxy = value(env, 'no_proxy', 'NO_PROXY') ?? saved.noProxy ?? '';
  noProxy = noProxy.trim() === '*' ? '*' : `${noProxy},${loopback}`;
  noProxy = [...new Set(noProxy.split(/[,\s]+/).filter(Boolean))].join(',');
  for (const proxy of [httpProxy, httpsProxy]) {
    if (!proxy) continue;
    try {
      const url = new URL(proxy);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash) throw Error();
    } catch { throw new Error('外网代理必须使用有效的 http:// 或 https:// 地址；请检查 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY'); }
  }
  return { httpProxy, httpsProxy, noProxy };
}
export function saveNetwork(root: string, env = process.env) {
  atomic(path.join(root, 'network.json'), networkSettings(root, env));
}
export function networkEnvironment(root: string, env = process.env): NodeJS.ProcessEnv {
  const settings = networkSettings(root, env);
  return { ...env, HTTP_PROXY: settings.httpProxy, http_proxy: settings.httpProxy,
    HTTPS_PROXY: settings.httpsProxy, https_proxy: settings.httpsProxy,
    NO_PROXY: settings.noProxy, no_proxy: settings.noProxy };
}
export function createUpstreamFetch(root: string, env = process.env) {
  const dispatcher = new EnvHttpProxyAgent(networkSettings(root, env));
  const request: UpstreamFetch = (url, options) => fetch(url, {
    ...options as import('undici').RequestInit, dispatcher,
  }) as unknown as Promise<Response>;
  return {
    fetch: request,
    close: () => dispatcher.destroy(),
  };
}
