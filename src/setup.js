// Internal installation entry point, called by install.sh after npm installation.
import { install } from './install.js';
import { installCompletion } from './completion.js';
import { home } from './store.js';
const port = Number(process.env.SWITCH_PORT || 18345);
try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SWITCH_PORT must be 1–65535');
  await install(home(), port);
  installCompletion();
  console.log('已配置 Bash/Zsh 补全；请重新打开终端，或执行 source ~/.bashrc（Zsh 使用 source "${ZDOTDIR:-$HOME}/.zshrc"）。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
