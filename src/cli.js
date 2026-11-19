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
import { choose } from './menu.js';
import { candidates } from './completion.js';
import { updateTool } from './update.js';
import { service } from './install.js';
import { codexBinary } from './codex-binary.js';
import { TaskSync } from './task-sync.js';
import os from 'node:os';

const help = `easy-switch
  switch                      交互选择客户端、服务商或管理操作
  switch add                  交互选择 Codex/Claude 与 API/订阅
  switch <alias>              快速切换 Codex 服务商
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
  switch sync setup           配置 WebDAV 或自建任务同步服务
  switch sync list            列出可勾选的 Codex 任务
  switch sync add|remove <id>  开启或关闭指定任务的自动同步
  switch sync project <key> <path>  首次指定本机项目位置
  switch sync now             立即同步；后台服务会自动持续同步
  switch sync resolve <id> local|remote  选择发生冲突时保留的版本
  switch uninstall            恢复客户端设置并彻底卸载（含已保存的账号/API）
  switch service status|restart|uninstall
兼容：省略 codex 前缀的 add/edit/remove/list/order/<alias> 仍管理 Codex
环境：SWITCH_HOME、SWITCH_PORT（默认 18345）、SWITCH_CODEX_BIN
首次安装：./install.sh；后续更新：switch update`;
const args = process.argv.slice(2);
const appRoot = home();
let client = ['codex', 'claude'].includes(args[0]) ? args.shift() : null;
let isClaude, root, prefix;
function selectClient(value) {
  client = value; isClaude = client === 'claude'; root = isClaude ? path.join(appRoot, 'claude') : appRoot;
  prefix = `switch ${client || 'codex'}`;
}
selectClient(client);
async function interactive() {
  if (!client) {
    const value = await choose('easy-switch · 选择客户端', ['codex', 'claude'].map(value => ({ value, label: value === 'codex' ? 'Codex' : 'Claude' })));
    if (!value) return false;
    selectClient(value);
  }
  if (!args.length) {
    const state = init(root);
    const action = await choose(`easy-switch · ${isClaude ? 'Claude' : 'Codex'}`, [
      ...providerOrder(state).map(alias => ({ value: alias, label: `${state.active === alias ? '●' : '○'} ${alias} · ${state.providers[alias].type}` })),
      { value: 'add', label: '+ 添加服务商' }, { value: 'edit', label: '修改服务商' },
      { value: 'remove', label: '删除服务商' }, { value: 'order', label: '调整备用顺序' },
    ]);
    if (!action) return false;
    args.push(action);
    if (['edit', 'remove'].includes(action)) {
      const aliases = providerOrder(state);
      if (!aliases.length) throw new Error('尚未添加账号/API');
      const alias = await choose('选择服务商', aliases.map(value => ({ value, label: value })));
      if (!alias) return false;
      args.push(alias);
    }
  }
  if (args[0] === 'add' && args.length === 1) {
    const type = await choose('添加登录方式', [{ value: 'api', label: 'API 服务商' }, { value: 'account', label: '订阅账号' }]);
    if (!type) return false;
    args.push(type);
  }
  return true;
}
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
  if ((!args.length || args[0] === 'add' && args.length === 1) && process.stdin.isTTY && process.stdout.isTTY && !await interactive()) return;
  const [command, type, name] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) return console.log(help);
  if (command === '__complete') return console.log(candidates(args.slice(1), root).join('\n'));
  if (command === 'sync') {
    if (isClaude) throw new Error('Task sync currently supports Codex sessions.');
    const sync = new TaskSync({ root: appRoot, codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), binary: codexBinary() });
    try {
      if (type === 'setup') {
        const kind = await choose('同步存储', [{ value: 'webdav', label: 'WebDAV' }, { value: 'server', label: '自建服务器 / SQLite' }]);
        if (!kind) return;
        await sync.configure({ kind, url: await ask('服务器地址：'), username: kind === 'webdav' ? await ask('用户名：') : '',
          secret: await ask('密码 / 访问令牌（隐藏输入）：', true), passphrase: await ask('共享加密口令（至少 12 字符，隐藏输入）：', true), enabled: true });
        console.log('已保存同步配置；后台服务每 30 秒自动同步已选择任务。');
        try { service('restart', appRoot); } catch { console.log('请运行 switch service restart 使后台服务读取新配置。'); }
      } else if (type === 'list') {
        await sync.list();
        if (sync.config.url) await sync.run();
        const result = sync.snapshot(); if (result.error) console.error(result.error);
        for (const task of result.tasks) console.log(`${task.enabled ? '*' : ' '} ${task.id}  ${task.title}  ${task.status || ''}${task.projectKey ? '  project=' + task.projectKey : ''}${task.message ? '  ' + task.message : ''}`);
      } else if (['add', 'remove'].includes(type) && args.length === 3) {
        await sync.list(); if (sync.config.url) await sync.run();
        await sync.select({ id: name, enabled: type === 'add' }); await sync.run();
        console.log(type === 'add' ? '已开启任务自动同步' : '已停止同步该任务；保留两端历史');
      } else if (type === 'project' && args.length === 4) {
        await sync.mapProject({ key: name, directory: path.resolve(args[3]) }); await sync.run(); console.log('已保存本机项目位置');
      } else if (type === 'resolve' && args.length === 4) {
        const result = await sync.resolve({ id: name, choice: args[3] }); if (result.error) throw new Error(result.error); console.log('已保存版本选择；请通过 switch sync list 查看同步状态。');
      } else if (type === 'now') { const result = await sync.run(); if (result.error) throw new Error(result.error); console.log('同步完成；冲突和待指定位置请运行 switch sync list 查看。'); }
      else throw new Error('用法：switch sync setup|list|add <id>|remove <id>|project <key> <path>|resolve <id> local|remote|now');
    } finally { await sync.close(); }
    return;
  }
  if (command === 'update') {
    if (args.length !== 1) throw new Error('用法：switch update');
    return updateTool(appRoot);
  }
  if (command === 'uninstall' || command === 'service' && type === 'uninstall') {
    if (client || args.length > (command === 'service' ? 3 : 2) || args.some((arg, index) => index > (command === 'service' ? 1 : 0) && arg !== '--yes')) throw new Error('用法：switch uninstall [--yes]');
    if (!args.includes('--yes') && (await ask('将删除 easy-switch 保存的账号、密钥和缓存，恢复客户端连接。输入 yes 确认：')).toLowerCase() !== 'yes') return console.log('已取消');
    return service('uninstall', appRoot);
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
