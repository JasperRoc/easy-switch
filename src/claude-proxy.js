import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { init, readState, providerOrder, activateFallback } from './store.js';
import { claudeToken } from './claude-auth.js';
import { rejectionText, rejectionStatus, recoverable, atCapacity } from './failover.js';
import { inspectStartup } from './sse.js';
import { selectedModel } from './sessions.js';

export function claudeHeaders(provider, token, incoming = {}) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  for (const [key, value] of Object.entries(incoming)) if (/^(anthropic-|x-stainless-|x-claude-code-)/.test(key) || ['user-agent', 'x-app', 'accept'].includes(key)) headers[key] = value;
  if (provider.type === 'account') {
    headers.authorization = `Bearer ${token}`;
    headers['anthropic-beta'] = [...new Set((headers['anthropic-beta'] || '').split(',').filter(Boolean).concat('oauth-2025-04-20'))].join(',');
  } else headers['x-api-key'] = provider.apiKey;
  return headers;
}
export const claudeEndpoint = provider => (provider.baseUrl || 'https://api.anthropic.com').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
export function createClaudeHandler({ root, fetchImpl, sessions, reauth = () => {}, now = () => Date.now() }) {
  init(root);
  const cooldown = new Map(); let manual;
  return async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableFinished) abort.abort(); });
    const fail = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } })); };
    let session;
    try {
      let state = readState(root);
      const actual = Buffer.from(req.headers.authorization || (req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : ''));
      const expected = Buffer.from(`Bearer ${state.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(401, 'A local easy-switch token is required.');
      const target = new URL(req.url, 'http://localhost').pathname.slice('/claude'.length);
      const models = req.method === 'GET' && target === '/v1/models';
      if (!models && (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(target))) return fail(404, 'Only Anthropic Messages, token counting and model discovery are supported.');
      if (!state.providers[state.active]) return fail(409, 'Add a Claude Code provider first.');
      let payload;
      if (!models) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) return fail(413, 'Request exceeds 32 MiB.'); chunks.push(chunk); }
        payload = JSON.parse(Buffer.concat(chunks).toString());
        if (!payload || !Array.isArray(payload.messages)) return fail(400, 'A complete Messages history is required.');
      }
      const id = req.headers['x-claude-code-session-id'];
      if (!models && target === '/v1/messages') {
        session = sessions?.begin({ 'session-id': id }, { model: payload.model, reasoning: { effort: payload.output_config?.effort } });
        if (session) res.once('close', session.finish);
      }
      if (manual !== (state.manualGeneration || 0)) { cooldown.clear(); manual = state.manualGeneration || 0; }
      const attempted = new Set(); let alias = state.active;
      const selection = selectedModel(state, session?.id);
      const selectionAlias = session && Object.hasOwn(state.sessionModels || {}, session.id) ? state.active : state.modelSelectionAlias || state.active;
      while (alias && !abort.signal.aborted) {
        attempted.add(alias);
        const provider = state.providers[alias];
        let token;
        try { if (provider.type === 'account') token = await claudeToken(provider, fetchImpl); }
        catch { reauth(alias); }
        let upstream, stream, startup, message = '';
        if (provider.type === 'account' && !token) {
          upstream = new Response('', { status: 401 });
        } else {
          const outgoing = payload && { ...payload };
          // A provider-specific override must not send a DeepSeek model to a Claude subscription fallback.
          if (outgoing && selection && alias === selectionAlias) {
            outgoing.model = selection.model;
            if (selection.effort !== null) outgoing.output_config = { ...outgoing.output_config, effort: selection.effort };
            else if (outgoing.output_config) { outgoing.output_config = { ...outgoing.output_config }; delete outgoing.output_config.effort; }
          }
          session?.used(alias, { model: outgoing.model, reasoning: { effort: outgoing.output_config?.effort } });
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
          if (!models && (recoverable(status, message || JSON.stringify(startup?.error)) || capacity)) {
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
          return fail(status, status === 401 ? `Claude provider ${alias} needs authentication. Sign in in easy-switch or run switch claude add account ${alias}; API providers need a valid key.` : `Claude upstream ${alias} returned HTTP ${status}. Check model support and account access.`);
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
    } finally {
      session?.finish();
      if (session && sessions.entries.get(session.id)?.activeRequests === 0) sessions.entries.delete(session.id);
    }
  };
}
