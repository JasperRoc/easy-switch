import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createUpstreamFetch } from './network.js';

// Use an isolated, unauthenticated custom provider to read Codex's bundled catalog.
// This never starts/resumes a thread or copies the user's login credentials.
export async function codexModels({ binary = process.env.SWITCH_CODEX_BIN || 'codex', spawnImpl = spawn, timeoutMs = 12000 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-catalog-'));
  let child, lines, timer, exit;
  try {
    fs.writeFileSync(path.join(temp, 'config.toml'), 'cli_auth_credentials_store="file"\nmodel_provider="catalog"\n[model_providers.catalog]\nname="Model catalog"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n', { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      child = spawnImpl(binary, ['app-server'], { env: { ...process.env, CODEX_HOME: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function discoverModels(provider, root, { catalogImpl = codexModels, fetchImpl } = {}) {
  const models = await catalogImpl();
  if (provider.type !== 'api') return { models, notice: '目录来自 Codex CLI；实际可用性以当前账号权限为准。' };
  const client = fetchImpl ? null : createUpstreamFetch(root);
  try {
    const response = await (fetchImpl || client.fetch)(`${provider.baseUrl}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error(); }
    const result = await response.json();
    if (!Array.isArray(result.data)) throw Error();
    const available = new Set(result.data.map(item => item.id));
    return { models: models.filter(model => available.has(model.id)), notice: '仅列出服务商目录与 Codex 目录共同识别的模型。' };
  } catch {
    return { models, notice: '无法读取服务商 /models，显示 Codex 目录；请确认所选模型受该服务商支持。' };
  } finally { await client?.close(); }
}
