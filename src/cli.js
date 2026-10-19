#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { home, init, aliasName, addProvider, activate, baseURL, accountAuth, providerOrder, setOrder } from './store.js';
import { editOrder } from './order.js';
import { candidates } from './completion.js';
import { updateTool } from './update.js';
import { service } from './install.js';

const help = `easy-switch
  switch add api [alias]       添加官方或第三方 Responses API
  switch add account [alias]   通过 Codex 设备认证添加订阅账号
  switch <alias>               下一次模型请求切到该上游
  switch order [alias ...]    键盘调整自动切换优先级（从高到低）
  switch list | current       查看配置（不显示密钥）
  switch update               更新至官方仓库最新版本
  switch service status|restart|uninstall
环境：SWITCH_HOME、SWITCH_PORT（默认 18345）、SWITCH_CODEX_BIN
首次安装：./install.sh；后续更新：switch update`;
const args = process.argv.slice(2);
const root = home();
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
    return updateTool(root);
  }
  if (command === 'service') return service(type, root);
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
    if (Object.hasOwn(state.providers, alias)) throw new Error('别名已存在');
    let provider;
    if (type === 'api') {
      const baseUrl = baseURL(await ask('Base URL（留空使用 OpenAI 官方 API；第三方例如 https://example.com/v1）：'));
      const apiKey = await ask('API Key（隐藏输入）：', true);
      if (!apiKey) throw new Error('API Key 不能为空');
      provider = { type, baseUrl, apiKey };
    } else {
      const accountHome = path.join(root, 'accounts', alias);
      await login(accountHome);
      provider = { type, accountHome };
    }
    addProvider(alias, provider, root);
    return console.log(`已添加 ${alias}；使用 switch ${alias} 切换`);
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
  console.log(`已切换至 ${command}；新模型请求生效，进行中的请求不受影响`);
}
main().catch(e => { console.error(`错误：${e.code === 'ENOENT' ? '配置或 Codex 不存在，请先添加配置并安装 Codex CLI' : e.message}`); process.exitCode = 1; });
