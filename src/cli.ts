#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { home, init, aliasName, addProvider, editProvider, removeProvider, activate, baseURL, accountAuth, providerOrder, setOrder, type ProviderEdit } from './store.js';
import { claudeHome, startClaudeLogin, removeClaudeLogin } from './claude-auth.js';
import { activateClaude, claudeCompactWindows, restoreClaude } from './claude-config.js';
import { claudeFamilies, claudeModelEnvironment, type ClaudeModelMapping } from './claude-models.js';
import { editOrder } from './order.js';
import { candidates } from './completion.js';
import { updateTool } from './update.js';
import { service } from './install.js';
import { codexBinary } from './codex-binary.js';

const help = `fluid
  fd <alias>                  切换 Codex 服务商
  fd add account <alias>      添加 Codex 订阅账号
  fd add api <alias>          添加 OpenAI 官方或第三方 API
  fd edit <alias>             修改 Codex 服务商
  fd rm <alias>               删除 Codex 服务商
  fd ls                      查看 Codex 服务商与优先级
  fd order                   用键盘调整 Codex 优先级

  fd cc <alias>              切换 Claude 服务商
  fd cc add account <alias>  添加 Claude 订阅账号
  fd cc add api <alias>      添加 Anthropic 官方或第三方 API
  fd cc edit <alias>         修改 Claude 服务商
  fd cc rm <alias>           删除 Claude 服务商
  fd cc ls                   查看 Claude 服务商与优先级
  fd cc order                用键盘调整 Claude 优先级

  fd update                  更新 fluid
  fd uninstall               卸载 fluid 并恢复客户端设置
  fd help                    显示帮助`;
const args = process.argv.slice(2);
const appRoot = home();
const isClaude = args[0] === 'cc';
if (isClaude) args.shift();
const root = isClaude ? path.join(appRoot, 'claude') : appRoot;
const prefix = isClaude ? 'fd cc' : 'fd';
const connectClaude = () => {
  const state = init(root);
  if (!Object.keys(state.providers).length) return restoreClaude(path.join(appRoot, 'claude-session.json'));
  activateClaude(appRoot, claudeHome(), Number(process.env.SWITCH_PORT || 18345), state.token, claudeModelEnvironment(state.providers[state.active]), claudeCompactWindows(state.providers[state.active]));
};
async function ask(label, secret = false) {
  if (!process.stdin.isTTY) throw new Error('添加配置需要交互终端；请勿把密钥作为命令行参数');
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  if (secret) process.stdout.write(label);
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try { return (await rl.question(secret ? '' : label)).trim(); }
  finally { rl.close(); if (secret) process.stdout.write('\n'); }
}
function codex(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'linux' ? codexBinary() : process.env.SWITCH_CODEX_BIN || 'codex', args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}
async function login(accountHome) {
  fs.mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  const code = await codex(['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'], { ...process.env, CODEX_HOME: accountHome });
  if (code) throw new Error(`Codex 登录失败 (${code})`);
  accountAuth({ accountHome });
  fs.chmodSync(path.join(accountHome, 'auth.json'), 0o600);
}
async function main() {
  if (process.env.FLUID_COMPLETION === '1') return console.log(candidates(process.argv.slice(2), appRoot).join('\n'));
  const [command, type, name] = args;
  if (!command || command === 'help' && !isClaude && args.length === 1) return console.log(help);
  if (!isClaude && command === 'update' && args.length === 1) return updateTool(appRoot);
  if (!isClaude && command === 'uninstall' && args.length === 1) {
    if ((await ask('将删除 fluid 保存的账号、密钥和缓存，恢复客户端连接。输入 yes 确认：')).toLowerCase() !== 'yes') return console.log('已取消');
    return service('uninstall', appRoot);
  }
  if (command === 'rm') {
    if (args.length !== 2) throw new Error(`用法：${prefix} rm <alias>`);
    const state = init(root), provider = state.providers[type];
    if (!Object.hasOwn(state.providers, type)) throw new Error('未知别名');
    const owned = provider.type === 'account' ? path.resolve(provider.accountHome) : null;
    const removable = owned && path.dirname(owned) === path.join(root, 'accounts') && fs.existsSync(owned) &&
      !fs.lstatSync(owned).isSymbolicLink() && fs.realpathSync(path.dirname(owned)) === path.join(fs.realpathSync(root), 'accounts') &&
      !Object.entries(state.providers).some(([alias, item]) => alias !== type && item.accountHome && path.resolve(item.accountHome) === owned);
    if (isClaude && removable) await removeClaudeLogin(owned);
    removeProvider(type, root);
    if (isClaude) connectClaude();
    if (removable) fs.rmSync(owned, { recursive: true, force: true });
    return console.log(`已删除 ${isClaude ? 'Claude' : 'Codex'} 服务商 ${type}；当前：${init(root).active || '尚未选择'}`);
  }
  if (command === 'edit') {
    if (args.length !== 2) throw new Error(`用法：${prefix} edit <alias>`);
    const provider = init(root).providers[type];
    if (!provider) throw new Error('未知别名');
    const alias = await ask(`别名 [${type}]：`) || type, patch: ProviderEdit = { alias };
    if (provider.type === 'api') {
      const url = baseURL(await ask(`Base URL [${provider.baseUrl}]：`) || provider.baseUrl);
      if (url !== provider.baseUrl) patch.baseUrl = url;
      const apiKey = await ask('新 API Key（隐藏输入，留空保留）：', true); if (apiKey) patch.apiKey = apiKey;
      if (isClaude) patch.claudeModels = await askClaudeMapping(provider.claudeModels);
    }
    editProvider(type, patch, root);
    if (isClaude) connectClaude();
    return console.log(`已保存 ${alias}；下一次请求生效`);
  }
  if (command === 'order') {
    if (args.length !== 1) throw new Error(`用法：${prefix} order`);
    {
      const order = providerOrder(init(root));
      if (!order.length) return console.log('尚未添加账号/API');
      const edited = await editOrder(order);
      if (edited === null) return console.log('已取消，优先级未修改');
      setOrder(edited, root);
    }
    console.log(`已保存优先级；使用 ${prefix} ls 查看`);
    return;
  }
  if (command === 'add') {
    if (!['api', 'account'].includes(type) || args.length !== 3) throw new Error(`用法：${prefix} add api|account <alias>`);
    const alias = aliasName(name);
    const state = init(root);
    const existing = state.providers[alias];
    if (Object.hasOwn(state.providers, alias) && !(isClaude && type === 'account' && existing.type === 'account')) throw new Error('别名已存在');
    let provider;
    if (type === 'api') {
      const baseUrl = baseURL(await ask(isClaude ? 'Anthropic Messages Base URL（留空使用 Anthropic 官方 API）：' : 'Base URL（留空使用 OpenAI 官方 API；第三方例如 https://example.com/v1）：') || (isClaude ? 'https://api.anthropic.com' : ''));
      const apiKey = await ask('API Key（隐藏输入）：', true);
      if (!apiKey) throw new Error('API Key 不能为空');
      provider = { type, baseUrl, apiKey };
    } else {
      const accountHome = existing?.accountHome || path.join(root, 'accounts', randomUUID());
      if (isClaude) {
        const task = startClaudeLogin({ directory: accountHome });
        try {
          await task.ready;
          if (task.url) { console.log(task.url); task.submit(await ask('Claude 官方页面中的授权码：')); }
          if (!await task.completed) throw new Error(task.message);
        } finally { task.cancel(); }
      } else await login(accountHome);
      provider = { type, accountHome };
    }
    if (existing) editProvider(alias, { alias }, root); else addProvider(alias, provider, root);
    if (isClaude) connectClaude();
    return console.log(`已添加 ${alias}；使用 ${prefix} ${alias} 切换${isClaude ? '；首次接入后重新打开 Claude Code' : ''}`);
  }
  if (command === 'ls') {
    if (args.length !== 1) throw new Error(`用法：${prefix} ls`);
    const state = init(root), order = providerOrder(state);
    if (!order.length) return console.log('尚未添加账号/API');
    for (const [index, alias] of order.entries()) {
      const provider = state.providers[alias];
      console.log(`${index + 1}. ${alias === state.active ? '*' : ' '} ${alias}\t${provider.type}${provider.enabled === false ? ' [disabled]' : ''}${provider.type === 'api' ? '\t' + provider.baseUrl : ''}`);
    }
    return;
  }
  if (args.length !== 1) throw new Error(`用法：${prefix} <alias>`);
  if (['help', 'update', 'uninstall', 'cc'].includes(command) || !Object.hasOwn(init(root).providers, command)) throw new Error('未知命令或服务商；运行 fd help 查看用法');
  activate(aliasName(command), root);
  if (isClaude) connectClaude();
  console.log(`已切换至 ${command}；新模型请求生效，进行中的请求不受影响`);
}
async function askClaudeMapping(previous: ClaudeModelMapping = {}) {
  const mapping = {};
  for (const family of claudeFamilies) {
    const model = await ask(`${family[0].toUpperCase() + family.slice(1)} → 服务商模型 ID [${previous?.[family] || '不映射'}]（- 清除）：`);
    mapping[family] = model === '-' ? '' : model || previous?.[family];
  }
  const model = await ask(`Claude 主模型映射 [${previous?.default || '不映射'}]（- 清除）：`);
  const subagent = await ask(`Claude 子代理模型映射 [${previous?.subagent || '沿用主映射'}]（- 清除）：`);
  const { claudeModelMapping } = await import('./claude-models.js');
  return claudeModelMapping({ ...mapping, default: model === '-' ? '' : model || previous?.default, subagent: subagent === '-' ? '' : subagent || previous?.subagent });
}
main().catch(e => { console.error(`错误：${e.code === 'ENOENT' ? '配置或 Codex 不存在，请先添加配置并安装 Codex CLI' : e.message}`); process.exitCode = 1; });
