import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readState, accountAuth, activateFallback } from './store.js';
import { createReauth, expired } from './auth.js';
import { alternate, recoverable, rejectionText, atCapacity, capacityDelay } from './failover.js';
import { inspectStartup } from './sse.js';
import { applyModel } from './model.js';
import { createUpstreamFetch } from './network.js';
import { SessionTracker, selectedModel } from './sessions.js';

function authorized(req, token) {
  // Native subscription auth replaces Authorization inside Codex. The dedicated
  // local header authenticates routing without forwarding either client token.
  const a = Buffer.from(req.headers['x-easy-switch-token'] ? `Bearer ${req.headers['x-easy-switch-token']}` : req.headers.authorization || '');
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
  return Buffer.concat(chunks);
}
function jsonBody(raw) {
  const data = JSON.parse(raw.toString());
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求必须是 JSON 对象');
  return data;
}
// Some subscription responses omit Content-Type despite sending valid SSE.
async function sseBody(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return response.body;
  if (type || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let prefix = '';
  let inspected = 0;
  try {
    while (inspected < 16384) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      const part = value.subarray(0, 16384 - inspected);
      inspected += part.length;
      prefix += decoder.decode(part, { stream: true });
      const first = prefix.trimStart();
      if (/^(?:data:|event:|id:|retry:|:)/.test(first)) {
        return new ReadableStream({
          start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) controller.close(); else controller.enqueue(value);
            } catch (error) { controller.error(error); }
          },
          cancel(reason) { return reader.cancel(reason); },
        });
      }
      if (first && !['data:', 'event:', 'id:', 'retry:', ':'].some(field => field.startsWith(first))) break;
    }
    await reader.cancel();
    return null;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}
export function createProxy({ root, fetchImpl, reauth = createReauth(), now = () => performance.now(), sessions = new SessionTracker(), wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
  const outbound = fetchImpl ? null : createUpstreamFetch(root);
  fetchImpl ??= outbound.fetch;
  const cooldown = new Map(), imageCooldown = new Map();
  let manualGeneration;
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    let session;
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      let state = readState(root);
      if (!authorized(req, state.token)) return error(res, 401, '需要本地代理令牌');
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ service: 'easy-switch', active: state.active }));
      }
      const image = ['/v1/images/generations', '/v1/images/edits'].includes(req.url);
      if (req.method !== 'POST' || (!image && req.url !== '/v1/responses')) return error(res, 404, '仅支持 Responses 和图片生成/编辑请求');
      const raw = await body(req);
      const contentType = req.headers['content-type'] || 'application/json';
      if (image && !/^(?:application\/json|multipart\/form-data)(?:;|$)/i.test(contentType)) return error(res, 400, '图片请求须使用 JSON 或 multipart/form-data');
      const payload = image && /^multipart\//i.test(contentType) ? null : jsonBody(raw);
      if (!image) {
        if (payload.previous_response_id || payload.conversation) return error(res, 400, '切换代理要求完整 input；不支持上游响应 ID / conversation 引用');
        if (!Array.isArray(payload.input) && typeof payload.input !== 'string') return error(res, 400, '缺少 input');
        if (Array.isArray(payload.input) && payload.input.some(i => i.type === 'compaction' || i.type === 'item_reference')) return error(res, 400, '上下文含不可跨上游重放的压缩/引用项；请新建会话或使用可重放的本地摘要');
      }
      if (!state.providers[state.active]) return error(res, 409, '请先添加并选择账号/API');
      session = image ? null : sessions.begin(req.headers, payload);
      if (session) res.once('close', session.finish);
      if (manualGeneration !== (state.manualGeneration || 0)) {
        cooldown.clear(); imageCooldown.clear(); manualGeneration = state.manualGeneration || 0;
      }
      if (!image) {
        if (Array.isArray(payload.input)) payload.input = payload.input.filter(i => i.type !== 'reasoning');
        delete payload.previous_response_id;
        payload.store = false;
        payload.stream = true;
      }
      const modelSelection = selectedModel(state, session?.id);
      let alias = state.active;
      const accountsOnly = image && Object.values(state.providers).some(provider => provider.type === 'account');
      const accepts = provider => !!provider && (!accountsOnly || provider.type === 'account');
      const cooling = image ? imageCooldown : cooldown;
      if (accountsOnly) {
        const first = alternate(state, null, cooling, now(), new Set(), accepts);
        if (!first) {
          const account = Object.values(state.providers).find(provider => provider.type === 'account');
          let valid = false;
          try { valid = !expired(accountAuth(account)); } catch {}
          return valid ? error(res, 429, '订阅图片生成暂不可用，请稍后重试') : error(res, 401, await reauth.prompt(account));
        }
        alias = first;
      }
      const attempted = new Set();
      const maxAttempts = Object.values(state.providers).filter(accepts).length + 2;
      let capacityRetries = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attempted.add(alias);
        const provider = state.providers[alias];
        const headers = { 'content-type': image ? contentType : 'application/json', accept: image ? 'application/json' : 'text/event-stream' };
        let outgoing = { ...payload }; // Never carry an API's model override into the fallback.
        let url;
        if (provider.type === 'account') {
          let auth;
          try { auth = accountAuth(provider); } catch { return error(res, 401, await reauth.prompt(provider)); }
          if (expired(auth)) return error(res, 401, await reauth.prompt(provider));
          headers.authorization = `Bearer ${auth.tokens.access_token}`;
          headers['ChatGPT-Account-ID'] = auth.tokens.account_id;
          headers.originator = 'codex_cli_rs';
          headers['OpenAI-Beta'] = 'responses=experimental';
          url = 'https://chatgpt.com/backend-api/codex' + req.url.slice(3);
          if (!image) outgoing.instructions ??= '';
        } else {
          headers.authorization = `Bearer ${provider.apiKey}`;
          url = provider.baseUrl + req.url.slice(3);
        }
        if (!image) {
          if (provider.model) outgoing.model = provider.model;
          outgoing = applyModel(outgoing, modelSelection);
        }
        session?.used(alias, outgoing);
        const upstream = await fetchImpl(url, {
          method: 'POST', headers, body: image ? raw : JSON.stringify(outgoing), signal: abort.signal, redirect: 'error',
        });
        let stream, startup, message = '';
        if (!upstream.ok) message = await rejectionText(upstream);
        else if (!image || upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
          stream = await sseBody(upstream);
          if (!stream) return error(res, 502, '上游未返回 Responses SSE 流');
          startup = await inspectStartup(stream); stream = startup.stream;
        }
        const capacity = !upstream.ok ? atCapacity(message) : startup?.capacity;
        if (!upstream.ok || capacity) {
          const status = capacity ? 503 : upstream.status;
          if (capacity || recoverable(status, message)) {
            cooling.set(alias, now() + 60000);
            const next = attempt + 1 < maxAttempts && !abort.signal.aborted && alternate(state, alias, cooling, now(), attempted, accepts);
            let selected = false;
            // Compare generations so a late rejection cannot overwrite a manual choice.
            if (next && !image) {
              try { selected = activateFallback(next, state.generation || 0, alias, status, root); }
              catch { /* do not override a concurrent configuration writer */ }
            }
            if (next && (image || selected)) {
              await stream?.cancel();
              if (!image) state = { ...state, active: next, generation: (state.generation || 0) + 1 };
              alias = next; continue;
            }
            const latest = readState(root);
            if (attempt + 1 < maxAttempts && !abort.signal.aborted &&
                latest.generation !== state.generation && latest.active !== alias &&
                latest.providers[latest.active] && accepts(latest.providers[latest.active]) && !attempted.has(latest.active)) {
              await stream?.cancel();
              state = latest;
              alias = latest.active; continue;
            }
            const retryAfter = capacityDelay(upstream.headers.get('retry-after'), capacityRetries);
            if (capacity && capacityRetries < 2 && retryAfter <= 30000 && attempt + 1 < maxAttempts && !abort.signal.aborted) {
              await stream?.cancel();
              await wait(retryAfter, abort.signal); abort.signal.throwIfAborted();
              const current = readState(root);
              if (current.generation !== state.generation && accepts(current.providers[current.active])) { state = current; alias = current.active; }
              capacityRetries++; continue;
            }
          }
          // Preserve the native terminal SSE error after the bounded retries.
          if (startup?.capacity) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-switch-alias': alias });
            await pipeline(Readable.fromWeb(stream), res); return;
          }
          if (upstream.status === 401 && provider.type === 'account') return error(res, 401, await reauth.prompt(provider));
          return error(res, upstream.status, `上游 ${alias} 返回 HTTP ${upstream.status}`);
        }
        if (image && !stream && !/^application\/json(?:;|$)/i.test(upstream.headers.get('content-type') || '')) {
          await upstream.body?.cancel(); return error(res, 502, '上游未返回图片 JSON 响应');
        }
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache', 'x-switch-alias': alias });
        res.flushHeaders();
        // Accepted output and tool events are never replayed.
        await pipeline(Readable.fromWeb(stream || upstream.body), res);
        return;
      }
    } catch (e) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else error(res, e instanceof SyntaxError ? 400 : 502, e instanceof SyntaxError ? '无效 JSON' : '代理请求失败；检查配置、账号登录或上游连接');
    } finally { session?.finish(); }
  });
  server.on('close', () => {
    reauth.close();
    outbound?.close().catch(() => {});
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
  return server;
}
