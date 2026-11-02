#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { home, init, aliasName, addProvider, editProvider, activate, baseURL, accountAuth, providerOrder, setOrder, setModel } from './store.js';
import { claudeHome, startClaudeLogin } from './claude-auth.js';
import { activateClaude } from './claude-config.js';
import { discoverClaudeModels } from './catalog.js';
import { chooseModel } from './model.js';
import { editOrder } from './order.js';
import { candidates } from './completion.js';
import { updateTool } from './update.js';
import { service } from './install.js';

const help = `easy-switch
  switch add api [alias]       添加官方或第三方 Responses API
  switch add account [alias]   通过 Codex 设备认证添加订阅账号
  switch edit <alias>          修改别名、Base URL 或密钥（密钥留空保留）
  switch <alias>               下一次模型请求切到该上游
  switch model [current|reset]  选择模型与 effort，下一次模型请求生效
  switch model <id> [effort]   手动指定准确模型 ID（不会验证服务商权限）
  switch claude <command>     管理 Claude Code 的 API / 订阅、模型和队列
  switch order [alias ...]    键盘调整自动切换优先级（从高到低）
  switch list | current       查看配置（不显示密钥）
  switch update               更新至官方仓库最新版本
  switch service status|restart|uninstall
环境：SWITCH_HOME、SWITCH_PORT（默认 18345）、SWITCH_CODEX_BIN
首次安装：./install.sh；后续更新：switch update`;
const args = process.argv.slice(2);
const appRoot = home(), isClaude = args[0] === 'claude';
if (isClaude) args.shift();
const root = isClaude ? path.join(appRoot, 'claude') : appRoot;
const connectClaude = () => activateClaude(appRoot, claudeHome(), Number(process.env.SWITCH_PORT || 18345), init(root).token);
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
  if (command === 'model') {
    if (args.length > 3 || (['current', 'reset'].includes(type) && args.length !== 2)) throw new Error('用法：switch [claude] model [current|reset|<id> [effort]]');
    if (type === 'current') {
      const state = init(root), selection = isClaude && state.modelSelectionAlias && state.modelSelectionAlias !== state.active ? null : state.modelSelection;
      return console.log(selection ? `${selection.model} · effort: ${selection.effort ?? '服务商默认'}` : `跟随 ${isClaude ? 'Claude Code' : 'Codex'}`);
    }
    if (type === 'reset') { setModel(null, root); return console.log('已取消模型与 effort 覆盖；下一次模型请求生效'); }
    if (type) { setModel({ model: type, effort: name || null }, root); return console.log(`已指定 ${type}；实际可用性由服务商决定，下一次请求生效`); }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互终端执行 switch model；查看设置请用 switch model current');
    const result = await chooseModel(root, isClaude ? { client: 'Claude Code', discoverImpl: provider => discoverClaudeModels(provider, appRoot) } : {});
    if (result.cancelled) return console.log('已取消，模型设置未修改');
    if (result.notice) console.log(result.notice);
    console.log(result.selection ? `已选择 ${result.selection.model} · effort: ${result.selection.effort ?? '服务商默认'}` : '已取消模型与 effort 覆盖，跟随 Codex');
    return console.log('当前服务下所有会话的下一次模型请求生效；进行中的响应继续完成');
  }
  if (command === 'service') return service(type, appRoot);
  if (command === 'edit') {
    if (args.length !== 2) throw new Error('用法：switch [claude] edit <alias>');
    const provider = init(root).providers[type];
    if (!provider) throw new Error('未知别名');
    const alias = await ask(`别名 [${type}]：`) || type, patch = { alias };
    if (provider.type === 'api') {
      const url = baseURL(await ask(`Base URL [${provider.baseUrl}]：`) || provider.baseUrl);
      if (url !== provider.baseUrl) patch.baseUrl = url;
      const apiKey = await ask('新 API Key（隐藏输入，留空保留）：', true); if (apiKey) patch.apiKey = apiKey;
    }
    editProvider(type, patch, root);
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
    console.log('已保存优先级；使用 switch list 查看');
    return;
  }
  if (command === 'add') {
    if (!['api', 'account'].includes(type) || args.length > 3) throw new Error('用法：switch add api|account [alias]');
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
    return console.log(`已添加 ${alias}；使用 switch ${isClaude ? 'claude ' : ''}${alias} 切换${isClaude ? '；首次接入后重新打开 Claude Code' : ''}`);
  }
  if (command === 'list' || command === 'current') {
    const state = init(root);
    if (command === 'current') return console.log(state.active || '尚未选择');
    const order = providerOrder(state);
    if (!order.length) return console.log('尚未添加账号/API');
    for (const [index, alias] of order.entries()) {
      const p = state.providers[alias];
      console.log(`${index + 1}. ${alias === state.active ? '*' : ' '} ${alias}\t${p.type}${p.type === 'api' ? '\t' + p.baseUrl : ''}`);
    }
    return;
  }
  if (args.length !== 1) throw new Error('用法：switch <alias>');
  activate(aliasName(command), root);
  if (isClaude) connectClaude();
  console.log(`已切换至 ${command}；新模型请求生效，进行中的请求不受影响`);
}
main().catch(e => { console.error(`错误：${e.code === 'ENOENT' ? '配置或 Codex 不存在，请先添加配置并安装 Codex CLI' : e.message}`); process.exitCode = 1; });
