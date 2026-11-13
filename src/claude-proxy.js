import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { init, readState, providerOrder, activateFallback } from './store.js';
import { claudeToken, claudeHeaders, claudeEndpoint } from './claude-auth.js';
import { rejectionText, rejectionStatus, recoverable, atCapacity, modelUnavailable } from './failover.js';
import { inspectStartup } from './sse.js';
import { claudeModelFamily, mappedClaudeModel } from './claude-models.js';
import { claudeDesktopModels, claudeDesktopRoutes, mappedDesktopModel } from './claude-desktop.js';
import { discoverClaudeModels } from './catalog.js';
import { providerModels } from './provider-models.js';

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
  async function providerCatalog(alias, provider, signal) {
    const key = JSON.stringify(provider), cached = catalogs.get(alias);
    if (cached?.key === key && cached.until > now()) return cached.pending;
    const entry = { key, until: now() + 60000 };
    entry.pending = discoverClaudeModels(provider, root, { fetchImpl, signal }).then(result => ({ models: providerModels(provider, result.models), known: true })).catch(error => {
      if (signal.aborted) { if (catalogs.get(alias) === entry) catalogs.delete(alias); throw error; }
      return { models: providerModels(provider, cached?.key === key ? cached.models || [] : []), known: Array.isArray(provider.modelCatalog) };
    }).then(result => {
      entry.models = result.models;
      return { ...result, models: claudeDesktopRoutes(provider, result.models).map(route => ({ id: route.model, label: route.label })) };
    });
    catalogs.set(alias, entry);
    return entry.pending;
  }
  async function gatewayCatalog(state, signal) {
    for (const alias of catalogs.keys()) if (!state.providers[alias]) catalogs.delete(alias);
    const entries = await Promise.all(providerOrder(state).filter(alias => state.providers[alias]).map(async alias =>
      [alias, await providerCatalog(alias, state.providers[alias], signal)]));
    const models = new Map();
    for (const [, entry] of entries) for (const model of entry.models) if (!models.has(model.id)) models.set(model.id, model);
    return { providers: new Map(entries), models: [...models.values()] };
  }
  return async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableFinished) abort.abort(); });
    const fail = (status, message, detail = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'x-switch-service': 'easy-switch' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message, ...detail } })); };
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
      let catalog;
      if (models || desktop) catalog = await gatewayCatalog(state, abort.signal);
      if (models) {
        if (!catalog.models.length && [...catalog.providers.values()].every(entry => !entry.known)) return fail(503, 'easy-switch could not read any configured Claude model catalog. Check provider authentication and model-list permissions.');
        const result = claudeDesktopModels({}, 'easy-switch', catalog.models);
        result.first_id = result.data[0]?.id || null; result.last_id = result.data.at(-1)?.id || null;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-switch-service': 'easy-switch' });
        return res.end(JSON.stringify(result));
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) return fail(413, 'Request exceeds 32 MiB.'); chunks.push(chunk); }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (!payload || !Array.isArray(payload.messages)) return fail(400, 'A complete Messages history is required.');
      if (manual !== (state.manualGeneration || 0)) { cooldown.clear(); manual = state.manualGeneration || 0; }
      for (const [key, until] of cooldown) if (until <= now()) cooldown.delete(key);
      const requested = typeof payload.model === 'string' ? payload.model.replace(/\[1m\]$/i, '') : payload.model;
      const synthetic = /-es-[a-f0-9]{16}$/.test(requested || '');
      if (synthetic && !catalog) catalog = await gatewayCatalog(state, abort.signal);
      const exact = catalog && claudeDesktopRoutes({}, catalog.models).find(route => route.id === requested || route.model === requested);
      if (synthetic && !exact) return fail(400, 'The selected easy-switch model is no longer in any configured catalog. Refresh the model list and select an available model.', { code: 'model_not_found' });
      const explicitModel = synthetic ? exact.model : (requested && requested !== 'default' && !/^claude-/i.test(requested) && !claudeModelFamily(requested) ? requested : null);
      const attempted = new Set(), failures = []; let alias = state.active, routedModel = explicitModel;
      const modelFor = name => {
        const provider = state.providers[name];
        const model = routedModel || (desktop ? mappedDesktopModel(provider, requested, catalog.providers.get(name)?.models || [], req.headers) : mappedClaudeModel(provider, requested, req.headers));
        return typeof model === 'string' ? model.replace(/\[1m\]$/i, '') : model;
      };
      const blocked = (name, model) => Math.max(cooldown.get(JSON.stringify([name, null])) || 0, cooldown.get(JSON.stringify([name, model])) || 0) > now();
      const supports = (name, model) => {
        const entry = catalog?.providers.get(name), provider = state.providers[name];
        if (!provider) return false;
        if (entry?.models.some(item => item.id === model)) return true;
        if (entry?.known) return false;
        return provider.type !== 'account' || /^claude-/.test(model || '');
      };
      while (alias && !abort.signal.aborted) {
        attempted.add(alias);
        const provider = state.providers[alias];
        const model = modelFor(alias);
        if (desktop && (!requested || requested === 'default')) routedModel = model;
        let token;
        let upstream, stream, startup, message = '';
        const unsupported = !supports(alias, model);
        if (unsupported) {
          upstream = Response.json({ error: { code: 'model_not_found', message: 'This provider does not list the selected model.' } }, { status: 400 });
        } else if (blocked(alias, model)) {
          upstream = Response.json({ error: { message: 'This provider is temporarily cooling down after an upstream rejection.' } }, { status: 429 });
        } else {
          try { if (provider.type === 'account') token = await claudeToken(provider, fetchImpl); }
          catch { reauth(alias); }
          if (provider.type === 'account' && !token) {
            upstream = Response.json({ error: { message: 'The saved Claude subscription needs sign-in in easy-switch.' } }, { status: 401 });
          } else {
            try {
              upstream = await fetchImpl(claudeEndpoint(provider) + target + new URL(req.url, 'http://localhost').search, {
                method: 'POST', headers: claudeHeaders(provider, token, req.headers),
                body: JSON.stringify({ ...payload, model }), redirect: 'error', signal: abort.signal,
              });
            } catch (error) {
              if (abort.signal.aborted) throw error;
              upstream = Response.json({ error: { message: 'The upstream connection failed before any response was accepted.' } }, { status: 502 });
            }
          }
        }
        if (!upstream.ok) message = await rejectionText(upstream);
        else if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
          startup = await inspectStartup(upstream.body, ['ping', 'message_start']); stream = startup.stream;
        }
        const capacity = startup?.capacity || atCapacity(message);
        const startupError = startup?.error;
        const streamStatus = rejectionStatus(startupError) || (startupError ? (modelUnavailable(400, JSON.stringify(startupError)) || startupError.type === 'invalid_request_error' ? 400 : 502) : 0);
        if (!upstream.ok || capacity || streamStatus) {
          const status = capacity ? 503 : streamStatus || upstream.status;
          const detail = upstreamMessage(message || JSON.stringify({ error: startup?.error }), [provider.apiKey, token, state.token]);
          failures.push({ provider: alias, model, status, message: detail, ...(unsupported ? { skipped: true } : {}) });
          const failureText = message || JSON.stringify(startup?.error);
          const temporary = [500, 502, 503, 504, 529].includes(status) && recoverable(403, failureText);
          if (recoverable(status, failureText) || modelUnavailable(status, failureText) || capacity || temporary) {
            cooldown.set(JSON.stringify([alias, [401, 402].includes(status) ? null : model]), now() + 60000);
            while (cooldown.size > 256) cooldown.delete(cooldown.keys().next().value);
            const latest = readState(root);
            // Honor a manual switch that occurred while this request was rejected.
            const changed = latest.generation !== state.generation;
            const next = changed ? (latest.active !== alias && !attempted.has(latest.active) && latest.providers[latest.active] ? latest.active : null)
              : providerOrder(state).find(name => !attempted.has(name) && state.providers[name] && !blocked(name, modelFor(name)));
            if (next) {
              await stream?.cancel(); state = latest; alias = next; continue;
            }
          }
          if (status === 401 && provider.type === 'account') reauth(alias);
          await stream?.cancel();
          // Upstream credentials are separate from Desktop's valid local credential.
          const cause = failures.findLast(failure => !failure.skipped) || failures.at(-1);
          const clientStatus = desktop && [401, 402].includes(cause.status) ? 502 : cause.status;
          return fail(clientStatus, `easy-switch could not complete the request${model ? ` for model ${model}` : ''}. Tried: ${failures.map(failure => `${failure.provider} (${failure.skipped ? 'skipped' : `HTTP ${failure.status}`}${failure.message ? `: ${failure.message}` : ''})`).join(' → ')}`, { code: 'upstreams_unavailable', model, attempts: failures });
        }
        const type = upstream.headers.get('content-type') || 'application/json';
        if (!/^(?:application\/json|text\/event-stream)(?:;|$)/i.test(type)) { await upstream.body?.cancel(); return fail(502, 'The upstream did not return an Anthropic response.'); }
        if (alias !== state.active) { try { activateFallback(alias, state.generation || 0, state.active, failures.at(-1)?.status || 400, root); } catch {} }
        const headers = { 'content-type': type, 'cache-control': 'no-cache', 'x-switch-alias': alias, 'x-switch-service': 'easy-switch' };
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
