import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { init, atomic } from './store.js';
import { saveNetwork } from './network.js';

const providerName = 'easy_switch';
const unitName = 'easy-switch.service';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function patchedConfig(original, port, token) {
  const before = parse(original);
  if (before.model_providers?.[providerName]) throw new Error('已存在 easy_switch provider；请先卸载旧接入配置');
  // Preserve comments and formatting; parse + compare both sides to fail closed on unusual TOML.
  let source = original;
  if (Object.hasOwn(before, 'model_provider')) {
    const pattern = /^[ \t]*(?:model_provider|"model_provider"|'model_provider')[ \t]*=[^\r\n]*(?:\r?\n|$)/m;
    if (!pattern.test(source)) throw new Error('无法安全修改 model_provider，请将其改为单行根配置');
    source = source.replace(pattern, '');
  }
  const provider = {
    name: 'easy-switch', base_url: `http://127.0.0.1:${port}/v1`,
    wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
    http_headers: { Authorization: `Bearer ${token}` },
  };
  const result = `model_provider = "${providerName}"\n${source}\n[model_providers.${providerName}]\nname = "easy-switch"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
  const expected = { ...before, model_provider: providerName, model_providers: { ...before.model_providers, [providerName]: provider } };
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(parse(result))), JSON.parse(JSON.stringify(expected)))) throw new Error('TOML 结构复杂，无法只修改代理设置；未写入配置');
  return result;
}
export function prepareConfig(root, codexHome, port, token) {
  const file = path.join(codexHome, 'config.toml');
  const recordFile = path.join(root, 'installation.json');
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : '';
  if (fs.existsSync(recordFile)) {
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (record.file !== file || record.port !== port || digest(original) !== record.installedHash) throw new Error('安装后配置/路径/端口发生变化，请先手动合并或卸载；不会覆盖你的修改');
    if (parse(original).model_providers?.[providerName]?.http_headers?.Authorization !== `Bearer ${token}`) throw new Error('本地令牌发生变化，请先恢复旧安装配置再安装');
    return { apply() {} };
  }
  const installed = patchedConfig(original, port, token);
  return { apply() {
    if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== original) throw new Error('安装期间配置被修改，停止写入');
    atomic(recordFile, { file, port, exists, original, installedHash: digest(installed) });
    writeText(file, installed);
  } };
}
export function restoreConfig(root) {
  const recordFile = path.join(root, 'installation.json');
  if (!fs.existsSync(recordFile)) return;
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const current = fs.readFileSync(record.file, 'utf8');
  if (digest(current) !== record.installedHash) throw new Error('config.toml 已被修改，拒绝覆盖；请根据 installation.json 中的原配置手动恢复');
  if (record.exists) writeText(record.file, record.original);
  else fs.unlinkSync(record.file);
  fs.unlinkSync(recordFile);
}
function quote(value, exec = false) {
  if (/[\r\n\0]/.test(value)) throw new Error('服务路径不能包含换行或 NUL');
  const escaped = value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return '"' + (exec ? escaped.replaceAll('$', '$$') : escaped) + '"';
}
export function unitText(root, port, node, daemon, codex = 'codex', searchPath = process.env.PATH || '/usr/bin:/bin') {
  return `[Unit]\nDescription=easy-switch switching proxy\n\n[Service]\nType=simple\nExecStart=${quote(node, true)} ${quote(daemon, true)}\nEnvironment=${quote('SWITCH_HOME=' + root)}\nEnvironment="SWITCH_PORT=${port}"\nEnvironment=${quote('SWITCH_CODEX_BIN=' + codex)}\nEnvironment=${quote('PATH=' + searchPath)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(' ')} 失败：${result.stderr?.trim() || result.error?.message || result.status}`);
  return result.stdout.trim();
}
function linux() {
  if (process.platform !== 'linux') throw new Error('后台安装目前支持采用 systemd 的 Linux 服务器；请在服务器上安装，本机不会注册服务');
}
function unitFile() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', unitName); }
export async function install(root, port) {
  linux();
  const binary = process.env.SWITCH_CODEX_BIN || 'codex';
  const executable = path.isAbsolute(binary) ? binary : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, binary)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('Codex CLI not found; install it before running ./install.sh');
  const { token } = init(root);
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const plan = prepareConfig(root, codexHome, port, token);
  command('systemctl', ['--user', 'show-environment']);
  try {
    command('loginctl', ['enable-linger', os.userInfo().username]);
    if (command('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']) !== 'yes') throw new Error('linger 未启用');
  } catch { throw new Error(`无法启用开机自启。请管理员运行 sudo loginctl enable-linger ${os.userInfo().username}，然后重新运行 ./install.sh`); }
  if (fs.existsSync(unitFile()) && !fs.readFileSync(unitFile(), 'utf8').includes(`Environment=${quote('SWITCH_HOME=' + root)}\n`)) throw new Error('服务已绑定其他 SWITCH_HOME，拒绝覆盖');
  saveNetwork(root);
  writeText(unitFile(), unitText(root, port, process.execPath, fileURLToPath(new URL('./daemon.js', import.meta.url)), executable));
  command('systemctl', ['--user', 'daemon-reload']);
  command('systemctl', ['--user', 'enable', unitName]);
  command('systemctl', ['--user', 'restart', unitName]);
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    try {
      const result = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
      if (result.ok && (await result.json()).service === 'easy-switch') { healthy = true; break; }
    } catch { /* systemd may still be starting the process */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!healthy) throw new Error('服务未就绪，尚未修改 Codex 配置；运行 journalctl --user -u easy-switch 查看日志');
  if (command('systemctl', ['--user', 'is-active', unitName]) !== 'active' || command('systemctl', ['--user', 'is-enabled', unitName]) !== 'enabled') throw new Error('服务未处于 active/enabled 状态，尚未修改 Codex 配置');
  plan.apply();
  console.log(`已启动后台服务并启用开机自启；已配置 ${path.join(codexHome, 'config.toml')}。首次请重启 Codex/重载远程 VS Code 窗口，以后正常使用 codex 或插件即可。`);
}
export function service(action, root) {
  linux();
  if (fs.existsSync(unitFile()) && !fs.readFileSync(unitFile(), 'utf8').includes(`Environment=${quote('SWITCH_HOME=' + root)}\n`)) throw new Error('服务属于其他 SWITCH_HOME，拒绝操作');
  if (action === 'uninstall') {
    restoreConfig(root);
    command('systemctl', ['--user', 'disable', '--now', unitName]);
    fs.rmSync(unitFile(), { force: true });
    command('systemctl', ['--user', 'daemon-reload']);
    console.log('已恢复配置并移除服务；保留账号数据和用户 linger 设置');
  } else if (action === 'restart') command('systemctl', ['--user', 'restart', unitName]);
  else if (action === 'status') console.log(command('systemctl', ['--user', 'status', unitName, '--no-pager']));
  else throw new Error('用法：switch service status|restart|uninstall');
}
