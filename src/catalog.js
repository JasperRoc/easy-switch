import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createUpstreamFetch } from './network.js';
import { accountAuth, atomic, providerOrder } from './store.js';
import { claudeToken, claudeHeaders, claudeEndpoint } from './claude-auth.js';
import { providerModels } from './provider-models.js';

// Client metadata only enriches exact provider IDs; it never supplies available IDs.
const clientCatalogs = new Map();
function metadataFromModel(model) {
  return { ...model.metadata, display_name: model.label,
    default_reasoning_level: model.defaultEffort ?? null,
    supported_reasoning_levels: model.metadata?.supported_reasoning_levels || (model.efforts || []).map(effort => ({ effort, description: effort })) };
}
function clientCatalog(binary) {
  if (!clientCatalogs.has(binary)) clientCatalogs.set(binary, codexModels({ binary, includeHidden: true }).then(models =>
    models.map((model, priority) => ({ ...model, metadata: { priority, visibility: model.hidden ? 'hide' : 'list', ...metadataFromModel(model) } })))
    .catch(() => []));
  return clientCatalogs.get(binary);
}
function codexTextModel(model) {
  return !['hide', 'none'].includes(model.metadata?.visibility) && !model.hidden
    && !/(?:^|[/:])(?:gpt-image(?:[-.]|$)|chatgpt-image(?:[-.]|$)|dall-e(?:[-.]|$))/i.test(model.id)
    && !(Array.isArray(model.metadata?.output_modalities) && !model.metadata.output_modalities.includes('text'));
}
function compareCodexModels(a, b) {
  const firstSeries = a.id.match(/^gpt-(\d+(?:\.\d+)*)(?:-|$)/i)?.[1];
  const secondSeries = b.id.match(/^gpt-(\d+(?:\.\d+)*)(?:-|$)/i)?.[1];
  if (firstSeries !== secondSeries) {
    if (!firstSeries) return secondSeries ? 1 : a.id.localeCompare(b.id, 'en', { numeric: true });
    if (!secondSeries) return -1;
    return secondSeries.localeCompare(firstSeries, 'en', { numeric: true });
  }
  const first = a.pickerPriority ?? a.metadata?.priority, second = b.pickerPriority ?? b.metadata?.priority;
  return (Number.isFinite(first) ? first : Number.MAX_SAFE_INTEGER) - (Number.isFinite(second) ? second : Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id, 'en', { numeric: true });
}
async function enrichCodexModels(models, metadataImpl) {
  const visible = models.filter(codexTextModel);
  if (!visible.length) return [];
  let native;
  try { native = await metadataImpl(); } catch { native = []; }
  const metadata = new Map(native.map((model, priority) => [model.id, { priority, visibility: model.hidden ? 'hide' : 'list', ...metadataFromModel(model) }]));
  return visible.map(model => {
    const reference = metadata.get(model.id);
    const details = { ...reference, ...model.metadata };
    return { ...model, pickerPriority: reference?.priority ?? model.metadata?.priority, label: model.label === model.id ? details.display_name || model.id : model.label, metadata: details,
      efforts: (details.supported_reasoning_levels || []).map(level => level.effort), defaultEffort: details.default_reasoning_level ?? null };
  }).filter(codexTextModel).sort(compareCodexModels);
}

// Read model metadata in an isolated app-server without creating a thread.
export async function codexModels({ binary = process.env.SWITCH_CODEX_BIN || 'codex', provider, spawnImpl = spawn, timeoutMs = 12000, signal, includeHidden = false } = {}) {
  signal?.throwIfAborted();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-catalog-'));
  let child, lines, timer, exit, originalAuth, onAbort;
  try {
    const account = provider?.type === 'account';
    if (account) {
      originalAuth = JSON.stringify(accountAuth(provider));
      fs.writeFileSync(path.join(temp, 'auth.json'), originalAuth, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(temp, 'config.toml'), 'cli_auth_credentials_store="file"\n' + (account ? '' : 'model_provider="catalog"\n[features]\napi_key_model_discovery=false\n[model_providers.catalog]\nname="Model catalog"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n'), { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      child = spawnImpl(binary, ['app-server'], { env: { ...process.env, CODEX_HOME: temp }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      exit = new Promise(done => child.once('close', done));
      child.stderr.resume();
      child.on('error', () => reject(new Error('无法读取模型目录，请检查 Codex CLI 或 SWITCH_CODEX_BIN')));
      child.stdin.on('error', () => reject(new Error('Codex 模型目录连接中断')));
      child.on('close', () => reject(new Error('Codex 模型目录进程提前退出')));
      timer = setTimeout(() => reject(new Error('读取 Codex 模型目录超时')), timeoutMs);
      let requestId = 1;
      const models = [];
      const cursors = new Set();
      const send = (method, params, id) => child.stdin.write(JSON.stringify({ method, params, ...(id == null ? {} : { id }) }) + '\n');
      const list = cursor => send('model/list', { limit: 100, includeHidden, cursor }, ++requestId);
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== requestId) return;
        if (message.error) return reject(new Error('Codex 不支持读取模型目录，请更新 Codex CLI'));
        if (requestId === 1) { send('initialized', {}); list(null); return; }
        if (!Array.isArray(message.result?.data)) return reject(new Error('Codex 返回了无效的模型目录'));
        models.push(...message.result.data);
        const cursor = message.result.nextCursor;
        if (cursor) {
          if (cursors.has(cursor) || models.length > 1000) return reject(new Error('Codex 模型目录分页异常'));
          cursors.add(cursor); list(cursor);
        } else resolve(models);
      });
      send('initialize', { clientInfo: { name: 'easy_switch_catalog', version: '1.0.0' } }, requestId);
    });
    return result.filter(model => (includeHidden || !model.hidden) && typeof model.model === 'string').map(model => ({
      id: model.model, label: model.displayName || model.model,
      efforts: (model.supportedReasoningEfforts || []).map(item => item.reasoningEffort).filter(effort => typeof effort === 'string'),
      defaultEffort: model.defaultReasoningEffort, ...(model.hidden ? { hidden: true } : {}),
    }));
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    lines?.close();
    if (child) {
      child.stdin.end(); child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      await exit;
      clearTimeout(force);
    }
    if (originalAuth) {
      try {
        const refreshed = accountAuth({ accountHome: temp });
        // Preserve a token refresh without overwriting a concurrent sign-in.
        if (JSON.stringify(accountAuth(provider)) === originalAuth && JSON.stringify(refreshed) !== originalAuth)
          atomic(path.join(provider.accountHome, 'auth.json'), refreshed);
      } catch { /* Removed providers and incomplete credentials are never restored. */ }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function discoverModels(provider, root, { fetchImpl, signal, clientVersion = '0.165.0', binary = process.env.SWITCH_CODEX_BIN || 'codex', metadataImpl = () => clientCatalog(binary) } = {}) {
  // Provider discovery must still work if local Codex metadata is unavailable.
  const client = fetchImpl ? null : createUpstreamFetch(root);
  try {
    const account = provider.type === 'account', auth = account ? accountAuth(provider) : null;
    const url = account ? `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}` : `${provider.baseUrl}/models`;
    const response = await (fetchImpl || client.fetch)(url, {
      headers: { authorization: `Bearer ${account ? auth.tokens.access_token : provider.apiKey}`, accept: 'application/json',
        ...(account ? { 'ChatGPT-Account-ID': auth.tokens.account_id, originator: 'codex_cli_rs' } : {}) },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error(); }
    const result = await response.json();
    if (account) {
      if (!Array.isArray(result.models)) throw Error();
      return { models: await enrichCodexModels(result.models.filter(item => typeof item?.slug === 'string' && !['hide', 'none'].includes(item.visibility)).map(item => ({
        id: item.slug, label: item.display_name || item.slug, metadata: item, metadataSource: 'subscription',
        efforts: (item.supported_reasoning_levels || []).map(level => level.effort), defaultEffort: item.default_reasoning_level || null,
      })), metadataImpl), notice: 'Models were read from this subscription’s live Codex catalog. Access depends on the account; no bundled models are added.' };
    }
    if (!Array.isArray(result.data)) throw Error();
    const ids = [...new Set(result.data.filter(item => typeof item?.id === 'string' && item.id.trim() && codexTextModel({ id: item.id, metadata: item })).map(item => item.id))];
    return { models: await enrichCodexModels(ids.map(id => ({ id, label: id })), metadataImpl),
      notice: ids.length ? '目录来自该服务商 /models；列出模型不代表已验证账号权限、Responses 或工具调用能力。' : '服务商 /models 返回了空目录，请检查 API 权限或服务商配置。' };
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new Error(provider.type === 'account'
      ? 'Unable to read this subscription’s live Codex model catalog. Check the connection and sign-in; no bundled models were substituted.'
      : '无法读取服务商 /models；不会使用 Codex 内置目录冒充该服务商的可用模型。请检查 Base URL、密钥和模型查询权限后重试。');
  } finally { await client?.close(); }
}

export function createCodexCatalog({ root, fetchImpl, binary = process.env.SWITCH_CODEX_BIN || 'codex', metadataImpl = () => clientCatalog(binary), now = () => Date.now() }) {
  const cache = new Map();
  const key = provider => JSON.stringify(provider) + (provider.type === 'account' ? JSON.stringify(accountAuth(provider)) : '');
  const peek = (alias, provider, version) => {
    try {
      const entry = cache.get(alias);
      return entry?.key === key(provider) && entry.version === version && entry.until > now() ? entry : null;
    } catch { return null; }
  };
  async function load(alias, provider, version, signal) {
    const cached = peek(alias, provider, version);
    if (cached) return cached.pending;
    let fingerprint;
    try { fingerprint = key(provider); } catch { return { models: providerModels(provider), known: Array.isArray(provider.modelCatalog) }; }
    const entry = { key: fingerprint, version, until: now() + 60000 };
    entry.pending = discoverModels(provider, root, { fetchImpl, signal, clientVersion: version, metadataImpl })
      .then(result => ({ models: providerModels(provider, result.models), known: true }))
      .catch(error => {
        if (signal.aborted) { if (cache.get(alias) === entry) cache.delete(alias); throw error; }
        return { models: providerModels(provider), known: Array.isArray(provider.modelCatalog) };
      }).then(result => { entry.result = result; return result; });
    cache.set(alias, entry);
    return entry.pending;
  }
  return {
    async union(state, version, signal) {
      for (const alias of cache.keys()) if (!state.providers[alias]) cache.delete(alias);
      const entries = await Promise.all(providerOrder(state).filter(alias => state.providers[alias]).map(async alias =>
        [alias, await load(alias, state.providers[alias], version, signal)]));
      const models = new Map();
      // Native metadata preserves capabilities for matching API IDs as well.
      for (const [, entry] of entries) for (const model of entry.models) {
        if (!models.has(model.id)) models.set(model.id, model);
        else if (models.get(model.id).metadataSource !== 'subscription' && model.metadataSource === 'subscription') models.set(model.id, { ...model, label: models.get(model.id).label });
      }
      const ordered = await enrichCodexModels([...models.values()], metadataImpl);
      return { models: ordered.map((model, priority) => ({
        base_instructions: 'Help the user with their coding tasks.', supported_reasoning_levels: [],
        shell_type: 'shell_command', support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 },
        experimental_supported_tools: [], visibility: 'list', ...model.metadata, slug: model.id, display_name: model.label,
        supported_in_api: true, priority, upgrade: null,
      })) };
    },
    supports(alias, provider, model) {
      if (Array.isArray(provider?.modelCatalog)) return provider.modelCatalog.some(entry => entry.id === model);
      const entry = cache.get(alias);
      try { return !entry || entry.key !== key(provider) || entry.until <= now() || !entry.result?.known || entry.result.models.some(item => item.id === model); }
      catch { return true; }
    },
  };
}

export async function discoverClaudeModels(provider, root, { fetchImpl, signal } = {}) {
  const client = fetchImpl ? null : createUpstreamFetch(root);
  fetchImpl ??= client.fetch;
  try {
    const token = provider.type === 'account' ? await claudeToken(provider, fetchImpl) : null;
    const headers = claudeHeaders(provider, token), models = [], seen = new Set(), cursors = new Set();
    const base = claudeEndpoint(provider);
    const endpoints = [...new Set([base + '/v1/models', ...(provider.type === 'api' ? [base + '/models', base.replace(/\/anthropic$/, '') + '/models'] : [])])];
    let endpoint = endpoints[0];
    let cursor;
    do {
      let response;
      for (let index = endpoints.indexOf(endpoint); index < endpoints.length; index++) {
        endpoint = endpoints[index];
        const url = endpoint + (cursor ? '?after_id=' + encodeURIComponent(cursor) : '');
        response = await fetchImpl(url, { headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
        if (cursor || ![404, 405].includes(response.status) || index === endpoints.length - 1) break;
        await response.body?.cancel();
      }
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      const data = await response.json();
      if (!Array.isArray(data.data)) throw Error();
      for (const item of data.data) if (typeof item?.id === 'string' && !seen.has(item.id)) {
        seen.add(item.id); models.push({ id: item.id, label: item.display_name || item.id,
          efforts: (item.capabilities?.effort?.supported_efforts || []).filter(effort => ['low', 'medium', 'high', 'max'].includes(effort)), defaultEffort: null });
      }
      const next = data.has_more ? data.last_id : null;
      if (next && (typeof next !== 'string' || cursors.has(next) || models.length >= 1000)) throw Error();
      if (next) cursors.add(next);
      cursor = next;
    } while (cursor);
    return { models, notice: 'Claude models come from this provider’s /v1/models endpoint. Listing a model does not guarantee Messages or tool compatibility.' };
  } catch { throw new Error('Unable to read this Claude provider’s model catalog. Check its Anthropic Messages endpoint and model-list permissions.'); }
  finally { await client?.close(); }
}
