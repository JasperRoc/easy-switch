import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { readState, accountAuth, activateFallback } from './store.js';
import { createReauth, expired } from './auth.js';
import { alternate, recoverable, rejectionText } from './failover.js';
import { createUpstreamFetch } from './network.js';

function authorized(req, token) {
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function error(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'switch_proxy_error' } }));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('请求超过 32 MiB');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString());
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求必须是 JSON 对象');
  return data;
}
export function createProxy({ root, fetchImpl, reauth = createReauth(), now = () => performance.now() }) {
  const outbound = fetchImpl ? null : createUpstreamFetch(root);
  fetchImpl ??= outbound.fetch;
  const cooldown = new Map();
  let manualGeneration;
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      let state = readState(root);
      if (!authorized(req, state.token)) return error(res, 401, '需要本地代理令牌');
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ service: 'easy-switch', active: state.active }));
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') return error(res, 404, '仅支持 POST /v1/responses');
      const payload = await body(req);
      if (payload.previous_response_id || payload.conversation) return error(res, 400, '切换代理要求完整 input；不支持上游响应 ID / conversation 引用');
      if (!Array.isArray(payload.input) && typeof payload.input !== 'string') return error(res, 400, '缺少 input');
      if (Array.isArray(payload.input) && payload.input.some(i => i.type === 'compaction' || i.type === 'item_reference')) return error(res, 400, '上下文含不可跨上游重放的压缩/引用项；请新建会话或使用可重放的本地摘要');
      if (!state.providers[state.active]) return error(res, 409, '请先添加并选择账号/API');
      if (manualGeneration !== (state.manualGeneration || 0)) {
        cooldown.clear(); manualGeneration = state.manualGeneration || 0;
      }
      if (Array.isArray(payload.input)) payload.input = payload.input.filter(i => i.type !== 'reasoning');
      delete payload.previous_response_id;
      payload.store = false;
      payload.stream = true;
      let alias = state.active;
      const attempted = new Set();
      const maxAttempts = Object.keys(state.providers).length;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attempted.add(alias);
        const provider = state.providers[alias];
        const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
        const outgoing = { ...payload }; // Never carry an API's model override into the fallback.
        let url;
        if (provider.type === 'account') {
          let auth;
          try { auth = accountAuth(provider); } catch { return error(res, 401, await reauth.prompt(provider)); }
          if (expired(auth)) return error(res, 401, await reauth.prompt(provider));
          headers.authorization = `Bearer ${auth.tokens.access_token}`;
          headers['ChatGPT-Account-ID'] = auth.tokens.account_id;
          headers.originator = 'codex_cli_rs';
          headers['OpenAI-Beta'] = 'responses=experimental';
          url = 'https://chatgpt.com/backend-api/codex/responses';
          outgoing.instructions ??= '';
        } else {
          headers.authorization = `Bearer ${provider.apiKey}`;
          url = `${provider.baseUrl}/responses`;
        }
        if (provider.model) outgoing.model = provider.model;
        const upstream = await fetchImpl(url, {
          method: 'POST', headers, body: JSON.stringify(outgoing), signal: abort.signal, redirect: 'error',
        });
        if (!upstream.ok) {
          const message = await rejectionText(upstream);
          if (recoverable(upstream.status, message)) {
            cooldown.set(alias, now() + 60000);
            const next = attempt + 1 < maxAttempts && !abort.signal.aborted && alternate(state, alias, cooldown, now(), attempted);
            let selected = false;
            // Compare generations so a late rejection cannot overwrite a manual choice.
            if (next) {
              try { selected = activateFallback(next, state.generation || 0, alias, upstream.status, root); }
              catch { /* do not override a concurrent configuration writer */ }
            }
            if (selected) {
              state = { ...state, active: next, generation: (state.generation || 0) + 1 };
              alias = next; continue;
            }
            const latest = readState(root);
            if (attempt + 1 < maxAttempts && !abort.signal.aborted &&
                latest.generation !== state.generation && latest.active !== alias &&
                state.providers[latest.active] && !attempted.has(latest.active)) {
              state = latest;
              alias = latest.active; continue;
            }
          }
          if (upstream.status === 401 && provider.type === 'account') return error(res, 401, await reauth.prompt(provider));
          return error(res, upstream.status, `上游 ${alias} 返回 HTTP ${upstream.status}`);
        }
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
          await upstream.body?.cancel();
          return error(res, 502, '上游未返回 Responses SSE 流');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-switch-alias': alias });
        res.flushHeaders();
        // Once accepted, including errors inside SSE, this response is never replayed.
        await pipeline(Readable.fromWeb(upstream.body), res);
        return;
      }
    } catch (e) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else error(res, e instanceof SyntaxError ? 400 : 502, e instanceof SyntaxError ? '无效 JSON' : '代理请求失败；检查配置、账号登录或上游连接');
    }
  });
  server.on('close', () => {
    reauth.close();
    outbound?.close().catch(() => {});
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
  return server;
}
