#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { home, init, aliasName, addProvider, editProvider, removeProvider, activate, baseURL, accountAuth, providerOrder, setOrder } from './store.js';
import { claudeHome, startClaudeLogin, removeClaudeLogin } from './claude-auth.js';
import { activateClaude, restoreClaude } from './claude-config.js';
import { claudeFamilies, claudeModelEnvironment } from './claude-models.js';
import { editOrder } from './order.js';
import { candidates } from './completion.js';
import { updateTool } from './update.js';
import { service } from './install.js';

const help = `easy-switch
  switch codex add api [alias]       添加官方或第三方 Responses API
  switch codex add account [alias]   通过 Codex 设备认证添加订阅账号
  switch claude add api [alias]      添加 Anthropic Messages API
  switch claude add account [alias]  通过 Claude 官方认证添加订阅账号
  switch <codex|claude> edit <alias>   修改别名、Base URL 或密钥（密钥留空保留）
  switch <codex|claude> remove <alias> 删除服务商及工具保存的独立登录凭据
  switch <codex|claude> <alias>        切换对应客户端的后续模型请求
  switch <codex|claude> order [alias ...]  调整独立备用队列（从高到低）
  switch <codex|claude> list | current     查看对应客户端（不显示密钥）
  switch current              分别显示 Codex 和 Claude 当前服务商
  switch update               更新至官方仓库最新版本
  switch service status|restart|uninstall
兼容：省略 codex 前缀的 add/edit/remove/list/order/<alias> 仍管理 Codex
环境：SWITCH_HOME、SWITCH_PORT（默认 18345）、SWITCH_CODEX_BIN
首次安装：./install.sh；后续更新：switch update`;
const args = process.argv.slice(2);
const appRoot = home(), client = ['codex', 'claude'].includes(args[0]) ? args.shift() : null, isClaude = client === 'claude';
const root = isClaude ? path.join(appRoot, 'claude') : appRoot;
const prefix = `switch ${client || 'codex'}`;
const connectClaude = () => {
  const state = init(root);
  if (!Object.keys(state.providers).length) return restoreClaude(path.join(appRoot, 'claude-session.json'));
  activateClaude(appRoot, claudeHome(), Number(process.env.SWITCH_PORT || 18345), state.token, claudeModelEnvironment(state.providers[state.active]));
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
    const child = spawn(process.env.SWITCH_CODEX_BIN || 'codex', args, { env, stdio: 'inherit' });
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
  const [command, type, name] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) return console.log(help);
  if (command === '__complete') return console.log(candidates(args.slice(1), root).join('\n'));
  if (command === 'update') {
    if (args.length !== 1) throw new Error('用法：switch update');
    return updateTool(appRoot);
  }
  if (command === 'service') return service(type, appRoot);
  if (command === 'remove') {
    if (args.length !== 2) throw new Error(`用法：${prefix} remove <alias>`);
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
    const alias = await ask(`别名 [${type}]：`) || type, patch = { alias };
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
    if (args.length > 1) setOrder(args.slice(1), root);
    else {
      const order = providerOrder(init(root));
      if (!order.length) return console.log('尚未添加账号/API');
      const edited = await editOrder(order);
      if (edited === null) return console.log('已取消，优先级未修改');
      setOrder(edited, root);
    }
    console.log(`已保存优先级；使用 ${prefix} list 查看`);
    return;
  }
  if (command === 'add') {
    if (!['api', 'account'].includes(type) || args.length > 3) throw new Error(`用法：${prefix} add api|account [alias]`);
    const alias = aliasName(name || await ask('别名：'));
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
  if (command === 'list' || command === 'current') {
    const state = init(root);
    if (args.length !== 1) throw new Error(`用法：${prefix} ${command}`);
    if (command === 'current') return console.log(client ? state.active || '尚未选择' : `Codex: ${state.active || '尚未选择'}\nClaude: ${init(path.join(appRoot, 'claude')).active || '尚未选择'}`);
    const order = providerOrder(state);
    if (!order.length) return console.log('尚未添加账号/API');
    for (const [index, alias] of order.entries()) {
      const p = state.providers[alias];
      console.log(`${index + 1}. ${alias === state.active ? '*' : ' '} ${alias}\t${p.type}${p.type === 'api' ? '\t' + p.baseUrl : ''}`);
    }
    return;
  }
  if (args.length !== 1) throw new Error(`用法：${prefix} <alias>`);
  activate(aliasName(command), root);
  if (isClaude) connectClaude();
  console.log(`已切换至 ${command}；新模型请求生效，进行中的请求不受影响`);
}
async function askClaudeMapping(previous = {}) {
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
