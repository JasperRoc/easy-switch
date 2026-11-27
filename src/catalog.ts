import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createUpstreamFetch } from './network.js';
import { accountAuth, atomic, providerOrder } from './store.js';
import { claudeToken, claudeHeaders, claudeEndpoint } from './claude-auth.js';
import { providerModels, type ModelEntry } from './provider-models.js';
import { codexVersionNumber, installedCodexVersion, resolveCodexExecutable, type CodexExecutable } from './codex-binary.js';
import type { Provider, ProviderState } from './store.js';
import type { UpstreamFetch } from './network.js';

interface ReasoningLevel { effort: string; description?: string; }
interface CodexMetadata {
  slug?: string;
  display_name?: string;
  visibility?: string;
  priority?: number;
  output_modalities?: string[];
  context_window?: number;
  max_context_window?: number;
  auto_compact_token_limit?: number | null;
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: ReasoningLevel[];
}
interface Model extends ModelEntry {
  metadata?: CodexMetadata;
  reportedContextWindow?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  hidden?: boolean;
  metadataReady?: boolean;
  metadataSource?: string;
  pickerPriority?: number;
}
interface CodexModelRPC {
  model: string;
  displayName?: string;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
  hidden?: boolean;
}
interface DiscoveryOptions {
  fetchImpl?: UpstreamFetch;
  signal?: AbortSignal;
  clientVersion?: string;
  binary?: CodexExecutable;
  metadataImpl?: () => Promise<Model[]>;
}
interface CatalogResult { models: Model[]; known: boolean; }
interface CatalogCache {
  key: string; until: number; pending?: Promise<CatalogResult>; result?: CatalogResult;
}
interface SavedCatalog {
  key: string; version: string; fetchedAt: number; models: Model[];
}
const catalogMaxAge = 24 * 60 * 60000;

// Client metadata only enriches exact provider IDs; it never supplies available IDs.
const clientCatalogs = new Map<string, Promise<Model[]>>();
const bundledMetadata: CodexMetadata[] = JSON.parse(fs.readFileSync(new URL('./codex-model-metadata.json', import.meta.url), 'utf8')).models;
// A provider's /models payload is not a Codex catalog. Validate the fields we
// forward so one partial entry cannot make Codex reject the entire model union.
function codexMetadata(value: CodexMetadata): CodexMetadata {
  const result = Object.fromEntries(Object.entries(value).filter(([, field]) => field != null)) as CodexMetadata;
  for (const key of ['default_reasoning_level', 'auto_compact_token_limit'] as const)
    if (value[key] === null) Object.assign(result, { [key]: null });
  for (const key of ['display_name', 'description', 'base_instructions', 'default_reasoning_level'])
    if (result[key] != null && typeof result[key] !== 'string') delete result[key];
  for (const key of ['context_window', 'max_context_window', 'auto_compact_token_limit', 'effective_context_window_percent', 'priority'])
    if (result[key] != null && !Number.isSafeInteger(result[key])) delete result[key];
  for (const key of ['support_verbosity', 'supports_parallel_tool_calls', 'supports_reasoning_summaries', 'supports_reasoning_summary_parameter',
    'supports_image_detail_original', 'include_skills_usage_instructions', 'include_plugin_usage_instructions', 'include_apps_usage_instructions',
    'supports_search_tool', 'supports_experimental_context', 'use_responses_lite', 'supports_reasoning_effort_updates', 'node_repl_auto_review_required', 'node_repl_disabled'])
    if (result[key] != null && typeof result[key] !== 'boolean') delete result[key];
  for (const [key, allowed] of Object.entries({ shell_type: ['shell_command', 'unified_exec', 'default', 'local', 'disabled'], visibility: ['list', 'hide', 'none'],
    default_reasoning_summary: ['auto', 'concise', 'detailed', 'none'], default_verbosity: ['low', 'medium', 'high'], apply_patch_tool_type: ['freeform'], web_search_tool_type: ['text', 'text_and_image'] }))
    if (result[key] != null && !allowed.includes(result[key])) delete result[key];
  for (const [key, allowed] of [['experimental_supported_tools', null], ['additional_speed_tiers', null], ['input_modalities', ['text', 'image', 'audio']]] as const) {
    if (!(key in result)) continue;
    if (!Array.isArray(result[key])) delete result[key];
    else result[key] = result[key].filter(item => typeof item === 'string' && (!allowed || (allowed as readonly string[]).includes(item)));
  }
  const policy = result['truncation_policy'];
  if ('truncation_policy' in result && (!policy || !['tokens', 'bytes'].includes(policy.mode) || !Number.isSafeInteger(policy.limit) || policy.limit < 0)) delete result['truncation_policy'];
  if (Array.isArray(value.supported_reasoning_levels)) {
    const seen = new Set<string>();
    const levels = value.supported_reasoning_levels.flatMap(item => {
      const effort = typeof item === 'string' ? item : item?.effort;
      if (typeof effort !== 'string' || !effort.trim() || seen.has(effort)) return [];
      seen.add(effort);
      return [{ effort, description: typeof item?.description === 'string' ? item.description : effort }];
    });
    if (levels.length || !value.supported_reasoning_levels.length) result.supported_reasoning_levels = levels;
    else delete result.supported_reasoning_levels;
  } else delete result.supported_reasoning_levels;
  return result;
}

function metadataFromModel(model: Model) {
  return { ...model.metadata, display_name: model.label,
    default_reasoning_level: model.defaultEffort ?? null,
    supported_reasoning_levels: model.metadata?.supported_reasoning_levels || (model.efforts || []).map(effort => ({ effort, description: effort })) };
}
function clientCatalog(source: CodexExecutable) {
  let binary: string, key: string;
  try {
    binary = resolveCodexExecutable(source);
    const stat = fs.statSync(binary);
    key = `${binary}:${stat.size}:${stat.mtimeMs}`;
  } catch { binary = typeof source === 'string' ? source : ''; key = binary; }
  if (!binary) return Promise.resolve([]);
  if (!clientCatalogs.has(key)) clientCatalogs.set(key, (async () => {
    if (path.isAbsolute(binary)) try {
      const directory = path.dirname(binary), reference: { version?: string; models?: Model[] } = JSON.parse(fs.readFileSync(path.join(directory, 'model-metadata.json'), 'utf8'));
      if (reference.version === fs.readFileSync(path.join(directory, 'version.txt'), 'utf8').trim() && Array.isArray(reference.models)) return reference.models;
    } catch { /* CLI installs and older bundles use the isolated official helper. */ }
    return codexModels({ binary, includeHidden: true });
  })().then(models =>
    models.map((model, priority) => ({ ...model, metadata: { priority, visibility: model.hidden ? 'hide' : 'list', ...metadataFromModel(model) } })))
    .catch(() => { clientCatalogs.delete(key); return []; }));
  return clientCatalogs.get(key);
}

export async function codexModelMetadata(binary: CodexExecutable) {
  return (await clientCatalog(binary)).map(model => ({ ...model.metadata, slug: model.id }));
}
function codexTextModel(model: Pick<Model, 'id' | 'metadata' | 'hidden'>) {
  return !['hide', 'none'].includes(model.metadata?.visibility) && !model.hidden
    && !/(?:^|[/:])(?:gpt-image(?:[-.]|$)|chatgpt-image(?:[-.]|$)|dall-e(?:[-.]|$))/i.test(model.id)
    && !(Array.isArray(model.metadata?.output_modalities) && !model.metadata.output_modalities.includes('text'));
}
function compareCodexModels(a: Model, b: Model) {
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
async function enrichCodexModels(models: Model[], metadataImpl: () => Promise<Model[]>) {
  const visible = models.filter(codexTextModel);
  if (!visible.length) return [];
  let native;
  try { native = visible.every(model => model.metadataReady && Array.isArray(codexMetadata(model.metadata || {}).supported_reasoning_levels)) ? [] : await metadataImpl(); } catch { native = []; }
  const metadata = new Map(bundledMetadata.map(model => [model.slug, model]));
  for (const [priority, model] of native.entries()) metadata.set(model.id, {
    ...metadata.get(model.id), priority, visibility: model.hidden ? 'hide' : 'list', ...metadataFromModel(model),
  });
  return visible.map(model => {
    const reference = metadata.get(model.id);
    const details = { ...codexMetadata(reference || {}), ...codexMetadata(model.metadata || {}) };
    const levels = details.supported_reasoning_levels;
    if (levels && !levels.some(level => level.effort === details.default_reasoning_level))
      details.default_reasoning_level = levels[0]?.effort ?? null;
    return { ...model, metadataReady: true, pickerPriority: reference?.priority ?? model.pickerPriority ?? model.metadata?.priority, label: model.label === model.id ? details.display_name || model.id : model.label, metadata: details,
      efforts: (details.supported_reasoning_levels || []).map(level => level.effort), defaultEffort: details.default_reasoning_level ?? null };
  }).filter(codexTextModel).sort(compareCodexModels);
}

// Read model metadata in an isolated app-server without creating a thread.
export async function codexModels({ binary = process.env.SWITCH_CODEX_BIN || 'codex', provider, spawnImpl = spawn, timeoutMs = 12000, signal, includeHidden = false }: {
  binary?: CodexExecutable; provider?: Provider; spawnImpl?: typeof spawn; timeoutMs?: number; signal?: AbortSignal; includeHidden?: boolean;
} = {}) {
  signal?.throwIfAborted();
  const executable = resolveCodexExecutable(binary);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-catalog-'));
  let child, lines, timer, exit, originalAuth, onAbort;
  try {
    const account = provider?.type === 'account';
    if (account) {
      originalAuth = JSON.stringify(accountAuth(provider));
      fs.writeFileSync(path.join(temp, 'auth.json'), originalAuth, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(temp, 'config.toml'), 'cli_auth_credentials_store="file"\n' + (account ? '' : 'model_provider="catalog"\n[features]\napi_key_model_discovery=false\n[model_providers.catalog]\nname="Model catalog"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n'), { mode: 0o600 });
    const result = await new Promise<CodexModelRPC[]>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      child = spawnImpl(executable, ['app-server'], { env: { ...process.env, CODEX_HOME: temp }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      exit = new Promise(done => child.once('close', done));
      child.stderr.resume();
      child.on('error', () => reject(new Error('无法读取模型目录，请检查 Codex CLI 或 SWITCH_CODEX_BIN')));
      child.stdin.on('error', () => reject(new Error('Codex 模型目录连接中断')));
      child.on('close', () => reject(new Error('Codex 模型目录进程提前退出')));
      timer = setTimeout(() => reject(new Error('读取 Codex 模型目录超时')), timeoutMs);
      let requestId = 1;
      const models: CodexModelRPC[] = [];
      const cursors = new Set();
      const send = (method: string, params: object, id?: number) => child.stdin.write(JSON.stringify({ method, params, ...(id == null ? {} : { id }) }) + '\n');
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
      send('initialize', { clientInfo: { name: 'fluid_catalog', version: '1.0.0' } }, requestId);
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
    if (originalAuth && provider?.type === 'account') {
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

export async function discoverModels(provider: Provider, root: string, { fetchImpl, signal, clientVersion, binary = process.env.SWITCH_CODEX_BIN || 'codex', metadataImpl = () => clientCatalog(binary) }: DiscoveryOptions = {}) {
  const account = provider.type === 'account';
  const version = account ? codexVersionNumber(clientVersion) || await installedCodexVersion(signal) : undefined;
  if (account && !version) throw new Error('Unable to read this subscription’s live Codex model catalog. Start Codex so fluid can detect its version, then try again.');
  // Provider discovery must still work if local Codex metadata is unavailable.
  const client = fetchImpl ? null : createUpstreamFetch(root);
  try {
    const auth = account ? accountAuth(provider) : null;
    const url = account ? `https://chatgpt.com/backend-api/codex/models?client_version=${version}` : `${provider.baseUrl}/models`;
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
        efforts: codexMetadata(item).supported_reasoning_levels?.map(level => level.effort) || [], defaultEffort: item.default_reasoning_level || null,
      })), metadataImpl), notice: 'Models were read from this subscription’s live Codex catalog. Access depends on the account; no bundled models are added.' };
    }
    if (!Array.isArray(result.data)) throw Error();
    const entries = new Map<string, CodexMetadata>(result.data.filter(item => typeof item?.id === 'string' && item.id.trim() && codexTextModel({ id: item.id, metadata: item })).map(item => [item.id, item]));
    return { models: await enrichCodexModels([...entries].map(([id, metadata]) => ({ id, label: id, metadata })), metadataImpl),
      notice: entries.size ? '目录来自该服务商 /models；列出模型不代表已验证账号权限、Responses 或工具调用能力。' : '服务商 /models 返回了空目录，请检查 API 权限或服务商配置。' };
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new Error(provider.type === 'account'
      ? 'Unable to read this subscription’s live Codex model catalog. Check the connection and sign-in; no bundled models were substituted.'
      : '无法读取服务商 /models；不会使用 Codex 内置目录冒充该服务商的可用模型。请检查 Base URL、密钥和模型查询权限后重试。');
  } finally { await client?.close(); }
}

export function createCodexCatalog({ root, fetchImpl, binary = process.env.SWITCH_CODEX_BIN || 'codex', metadataImpl = () => clientCatalog(binary), now = () => Date.now() }: DiscoveryOptions & { root: string; now?: () => number }) {
  const cache = new Map<string, CatalogCache>();
  const file = path.join(root, 'model-catalog-cache.json');
  let saved: Record<string, SavedCatalog> = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const key = (provider: Provider) => createHash('sha256').update(JSON.stringify(provider) + (provider.type === 'account' ? JSON.stringify(accountAuth(provider)) : '')).digest('hex');
  // Subscription availability can vary across the Codex clients sharing a proxy.
  const cacheId = (alias: string, provider: Provider, version?: string) => provider.type === 'account' ? `${alias}@${version}` : alias;
  async function load(alias: string, provider: Provider, version: string | undefined, signal: AbortSignal): Promise<CatalogResult> {
    const configured = { models: providerModels(provider), known: Array.isArray(provider.modelCatalog) };
    if (provider.type === 'account' && !version) return configured;
    let fingerprint;
    try { fingerprint = key(provider); } catch { return configured; }
    const id = cacheId(alias, provider, version);
    const cached = cache.get(id);
    if (cached?.key === fingerprint && cached.until > now()) return cached.result || cached.pending;
    const entry: CatalogCache = { key: fingerprint, until: now() + 60000 };
    const prior = saved[id] ?? saved[alias];
    const reusable = prior?.key === fingerprint && (provider.type === 'api' || prior.version === version)
      && now() - prior.fetchedAt < catalogMaxAge && Array.isArray(prior.models);
    const refresh = reusable ? AbortSignal.timeout(10000) : signal;
    entry.pending = discoverModels(provider, root, { fetchImpl, signal: refresh, clientVersion: version, metadataImpl })
      .then(result => ({ models: providerModels(provider, result.models), known: true }))
      .catch(error => {
        if (signal.aborted && !reusable) { if (cache.get(id) === entry) cache.delete(id); throw error; }
        return { models: reusable ? prior.models : configured.models, known: configured.known };
      }).then(result => {
        if (result.known && cache.get(id) === entry) {
          saved[id] = { key: fingerprint, version: provider.type === 'account' ? version : '', fetchedAt: now(), models: result.models };
          try { atomic(file, saved); } catch { /* An unwritable cache must not block discovery. */ }
        }
        entry.result = result; return result;
      });
    cache.set(id, entry);
    if (reusable) {
      const result = { models: prior.models, known: false };
      // Cached availability only speeds the menu. Inference still verifies stale
      // capabilities until the background refresh has answered.
      entry.result = result;
      entry.pending.catch(() => {});
      return result;
    }
    return entry.pending;
  }
  return {
    async union(state: ProviderState, version: string | undefined, signal: AbortSignal) {
      for (const [id, entry] of cache) {
        if (!Object.hasOwn(state.providers, id.split('@', 1)[0]) || entry.until <= now()) cache.delete(id);
      }
      for (const [id, entry] of Object.entries(saved)) {
        if (!Object.hasOwn(state.providers, id.split('@', 1)[0]) || now() - entry?.fetchedAt >= catalogMaxAge) delete saved[id];
      }
      if (!version && Object.values(state.providers).some(provider => provider.enabled !== false && provider.type === 'account'))
        version = await installedCodexVersion(signal);
      const entries = await Promise.all(providerOrder(state).filter(alias => state.providers[alias] && state.providers[alias].enabled !== false).map(async alias =>
        [alias, await load(alias, state.providers[alias], version, signal)] as const));
      const models = new Map<string, Model>();
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
    supports(alias: string, provider: Provider, model: string, version?: string) {
      if (Array.isArray(provider?.modelCatalog)) return provider.modelCatalog.some(entry => entry.id === model);
      if (provider?.type === 'account' && !version) return true;
      const entry = cache.get(cacheId(alias, provider, version));
      try { return !entry || entry.key !== key(provider) || entry.until <= now() || !entry.result?.known || entry.result.models.some(item => item.id === model); }
      catch { return true; }
    },
  };
}

export async function discoverClaudeModels(provider: Provider, root: string, { fetchImpl, signal }: Pick<DiscoveryOptions, 'fetchImpl' | 'signal'> = {}) {
  const client = fetchImpl ? null : createUpstreamFetch(root);
  fetchImpl ??= client.fetch;
  try {
    const token = provider.type === 'account' ? await claudeToken(provider, fetchImpl) : null;
    const headers = claudeHeaders(provider, token), models: Model[] = [], seen = new Set(), cursors = new Set();
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
          reportedContextWindow: item.max_input_tokens ?? item.context_window,
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
