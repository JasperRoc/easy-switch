import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareConfig } from './install.js';
import { readState } from './store.js';
import { networkEnvironment } from './network.js';

function run(binary, args, options) {
  const result = spawnSync(binary, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed (${result.error?.message || result.status})`);
  return result.stdout?.trim();
}
export function updateTool(root, execute = run) {
  if (process.platform !== 'linux' && execute === run) throw new Error('switch update 目前支持已安装服务的 Linux 服务器');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
  // Check configuration conflicts before replacing the installed package.
  prepareConfig(root, path.dirname(record.file), record.port, readState(root).token);
  const env = { ...networkEnvironment(root), SWITCH_HOME: root, SWITCH_PORT: String(record.port), CODEX_HOME: path.dirname(record.file) };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-update-'));
  const checkout = path.join(temp, 'source');
  try {
    console.log('正在更新至官方仓库 main 分支；完成后将重启代理，进行中的请求会中断。');
    execute('git', ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/JasperRoc/easy-switch.git', checkout], { env });
    // Use the same current-user installation/runtime path as the first install.
    // The installer prepends its selected runtime before invoking npm.
    execute('sh', [path.join(checkout, 'install.sh')], { env: { ...env, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH || '') } });
    console.log('easy-switch 更新完成。');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
