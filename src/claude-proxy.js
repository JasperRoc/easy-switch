import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { init, readState, providerOrder, activateFallback } from './store.js';
import { claudeToken, claudeHeaders, claudeEndpoint } from './claude-auth.js';
import { rejectionText, rejectionStatus, recoverable, atCapacity, modelUnavailable } from './failover.js';
import { inspectStartup } from './sse.js';
import { mappedClaudeModel } from './claude-models.js';
import { claudeDesktopModels, mappedDesktopModel } from './claude-desktop.js';
import { discoverClaudeModels } from './catalog.js';

export { claudeHeaders, claudeEndpoint } from './claude-auth.js';
function upstreamMessage(message, secrets) {
  let text;
  try { const data = JSON.parse(message), error = data.error || data; text = error.message; } catch {}
  if (typeof text !== 'string') return '';
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/Bearer\s+[^\s"',]+|\bsk-[\w-]+/gi, '[redacted]').replace(/[\x00-\x1f]/g, ' ').slice(0, 500);
}
export function createClaudeHandler({ root, fetchImpl, reauth = () => {}, now = () => Date.now() }) {
  init(root);
  const cooldown = new Map(), catalogs = new Map(); let manual;
  async function desktopCatalog(alias, provider, signal) {
    const key = JSON.stringify(provider), cached = catalogs.get(alias);
    if (cached?.key === key && cached.until > now()) return cached.pending;
    const pending = discoverClaudeModels(provider, root, { fetchImpl, signal }).then(result => result.models).catch(error => {
      if (provider.claudeModels?.default) return [];
      if (catalogs.get(alias)?.pending === pending) catalogs.delete(alias);
      throw error;
    });
    const entry = { key, until: now() + 60000, pending }; catalogs.set(alias, entry);
    return pending;
  }
  return async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableFinished) abort.abort(); });
    const fail = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } })); };
    try {
      let state = readState(root);
      const actual = Buffer.from(req.headers.authorization || (req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : ''));
      const expected = Buffer.from(`Bearer ${state.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(401, 'A local easy-switch token is required.');
      const desktop = req.url.startsWith('/claude-desktop/');
      const target = new URL(req.url, 'http://localhost').pathname.slice((desktop ? '/claude-desktop' : '/claude').length);
      const models = req.method === 'GET' && target === '/v1/models';
      if (!models && (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(target))) return fail(404, 'Only Anthropic Messages, token counting and model discovery are supported.');
      if (!state.providers[state.active]) return fail(409, 'Add a Claude Code provider first.');
      if (models && desktop) {
        const provider = state.providers[state.active];
        const catalog = await desktopCatalog(state.active, provider, abort.signal);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(claudeDesktopModels(provider, state.active, catalog)));
      }
      let payload;
      if (!models) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) return fail(413, 'Request exceeds 32 MiB.'); chunks.push(chunk); }
        payload = JSON.parse(Buffer.concat(chunks).toString());
        if (!payload || !Array.isArray(payload.messages)) return fail(400, 'A complete Messages history is required.');
      }
      if (manual !== (state.manualGeneration || 0)) { cooldown.clear(); manual = state.manualGeneration || 0; }
      const attempted = new Set(); let alias = state.active;
      while (alias && !abort.signal.aborted) {
        attempted.add(alias);
        const provider = state.providers[alias];
        let token;
        try { if (provider.type === 'account') token = await claudeToken(provider, fetchImpl); }
        catch { reauth(alias); }
        let upstream, stream, startup, message = '', model = payload?.model;
        if (provider.type === 'account' && !token) {
          upstream = new Response('', { status: 401 });
        } else {
          const outgoing = payload && { ...payload };
          if (outgoing) {
            outgoing.model = desktop ? mappedDesktopModel(provider, outgoing.model, await desktopCatalog(alias, provider, abort.signal).catch(() => []), req.headers) : mappedClaudeModel(provider, outgoing.model, req.headers);
            model = outgoing.model;
          }
          upstream = await fetchImpl(claudeEndpoint(provider) + target + new URL(req.url, 'http://localhost').search, {
            method: models ? 'GET' : 'POST', headers: claudeHeaders(provider, token, req.headers),
            ...(models ? {} : { body: JSON.stringify(outgoing) }), redirect: 'error', signal: abort.signal,
          });
        }
        if (!upstream.ok) message = await rejectionText(upstream);
        else if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
          startup = await inspectStartup(upstream.body, ['ping', 'message_start']); stream = startup.stream;
        }
        const capacity = startup?.capacity || atCapacity(message);
        const streamStatus = rejectionStatus(startup?.error);
        if (!upstream.ok || capacity || streamStatus) {
          const status = capacity ? 503 : streamStatus || upstream.status;
          if (!models && (recoverable(status, message || JSON.stringify(startup?.error)) || modelUnavailable(status, message || JSON.stringify(startup?.error)) || capacity)) {
            cooldown.set(alias, now() + 60000);
            const latest = readState(root);
            // Honor a manual switch that occurred while this request was rejected.
            const changed = latest.generation !== state.generation;
            const next = changed ? (latest.active !== alias && !attempted.has(latest.active) && latest.providers[latest.active] ? latest.active : null)
              : providerOrder(state).find(name => !attempted.has(name) && (cooldown.get(name) || 0) <= now() && state.providers[name]);
            let selected = changed && !!next;
            if (next && !changed) { try { selected = activateFallback(next, state.generation || 0, alias, status, root); } catch {} }
            if (next && selected) {
              await stream?.cancel(); state = readState(root); alias = next; continue;
            }
          }
          if (status === 401 && provider.type === 'account') reauth(alias);
          await stream?.cancel();
          const detail = upstreamMessage(message || JSON.stringify({ error: startup?.error }), [provider.apiKey, token, state.token]);
          return fail(status, status === 401 ? `Claude provider ${alias} needs authentication. Sign in in easy-switch or run switch claude add account ${alias}; API providers need a valid key.` : `Claude upstream ${alias} returned HTTP ${status}${model ? ` for model ${model}` : ''}.${detail ? ` ${detail}` : ' Check model mapping, account access and Anthropic Messages support.'}`);
        }
        const type = upstream.headers.get('content-type') || 'application/json';
        if (!/^(?:application\/json|text\/event-stream)(?:;|$)/i.test(type)) { await upstream.body?.cancel(); return fail(502, 'The upstream did not return an Anthropic response.'); }
        const headers = { 'content-type': type, 'cache-control': 'no-cache', 'x-switch-alias': alias };
        for (const [key, value] of upstream.headers) if (/^(anthropic-ratelimit-|retry-after$|request-id$|x-request-id$)/.test(key)) headers[key] = value;
        res.writeHead(200, headers); res.flushHeaders();
        await pipeline(Readable.fromWeb(stream || upstream.body), res); return;
      }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy(); else fail(error instanceof SyntaxError ? 400 : 502, 'Claude routing failed. Check the provider configuration and connection.');
    }
  };
}
