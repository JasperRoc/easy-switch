import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createUpstreamFetch } from './network.js';
import { accountAuth, atomic } from './store.js';

// Read model metadata in an isolated app-server without creating a thread.
export async function codexModels({ binary = process.env.SWITCH_CODEX_BIN || 'codex', provider, spawnImpl = spawn, timeoutMs = 12000 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-catalog-'));
  let child, lines, timer, exit, originalAuth;
  try {
    const account = provider?.type === 'account';
    if (account) {
      originalAuth = JSON.stringify(accountAuth(provider));
      fs.writeFileSync(path.join(temp, 'auth.json'), originalAuth, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(temp, 'config.toml'), 'cli_auth_credentials_store="file"\n' + (account ? '' : 'model_provider="catalog"\n[model_providers.catalog]\nname="Model catalog"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n'), { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
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
      const list = cursor => send('model/list', { limit: 100, includeHidden: false, cursor }, ++requestId);
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
    return result.filter(model => !model.hidden && typeof model.model === 'string').map(model => ({
      id: model.model, label: model.displayName || model.model,
      efforts: (model.supportedReasoningEfforts || []).map(item => item.reasoningEffort).filter(effort => typeof effort === 'string'),
      defaultEffort: model.defaultReasoningEffort,
    }));
  } finally {
    clearTimeout(timer);
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

export async function discoverModels(provider, root, { catalogImpl = codexModels, fetchImpl } = {}) {
  if (provider.type !== 'api') return { models: await catalogImpl(provider), notice: '使用当前订阅读取 Codex 模型目录；实际可用性以账号权限为准。' };
  // Provider discovery must still work if local Codex metadata is unavailable.
  const metadata = Promise.resolve().then(() => catalogImpl()).catch(() => []);
  const client = fetchImpl ? null : createUpstreamFetch(root);
  try {
    const response = await (fetchImpl || client.fetch)(`${provider.baseUrl}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error(); }
    const result = await response.json();
    if (!Array.isArray(result.data)) throw Error();
    const native = new Map((await metadata).map(model => [model.id, model]));
    const ids = [...new Set(result.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim()))];
    return { models: ids.map(id => native.get(id) || { id, label: id, efforts: [], defaultEffort: null }),
      notice: ids.length ? '目录来自服务商 /models；未识别的模型仅提供默认推理强度，请确认其支持 Responses 和 Codex 工具调用。' : '服务商 /models 返回了空目录，请检查 API 权限或服务商配置。' };
  } catch {
    const models = await metadata;
    if (!models.length) throw new Error('无法读取服务商和 Codex 模型目录，请检查连接设置后重试。');
    return { models, notice: '无法读取服务商 /models，显示 Codex 目录；请确认所选模型受该服务商支持。' };
  } finally { await client?.close(); }
}
