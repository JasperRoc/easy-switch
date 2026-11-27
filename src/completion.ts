import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userPrefix } from './linux-package.js';
import { readState, providerOrder } from './store.js';

export function candidates(words: string[], root: string, scoped = false) {
  if (!scoped && words.length > 1 && words[0] === 'cc') return candidates(words.slice(1), path.join(root, 'claude'), true);
  let aliases: string[] = [];
  try { aliases = providerOrder(readState(root)); } catch { /* Completion works before setup. */ }
  const prefix = words.at(-1) || '', before = words.slice(0, -1);
  let options: string[] = [];
  if (!before.length) options = ['add', 'edit', 'rm', 'ls', 'order', ...(!scoped ? ['cc', 'update', 'uninstall', 'help'] : []), ...aliases];
  else if (before.length === 1 && before[0] === 'add') options = ['account', 'api'];
  else if (before.length === 1 && ['edit', 'rm'].includes(before[0])) options = aliases;
  return options.filter(option => option.startsWith(prefix));
}
export function completionScript(shell) {
  if (shell === 'bash') return `_fluid_complete() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && COMPREPLY+=("$candidate")
  done < <(FLUID_COMPLETION=1 command fd "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -F _fluid_complete fd
`;
  return `autoload -Uz compinit
(( $+functions[compdef] )) || compinit
_fluid_complete() {
  local -a candidates
  candidates=("\${(@f)$(FLUID_COMPLETION=1 command fd "\${words[@]:1:$((CURRENT - 1))}" 2>/dev/null)}")
  compadd -- "\${candidates[@]}"
}
compdef _fluid_complete fd
`;
}
const start = '# >>> fluid completion >>>';
const end = '# <<< fluid completion <<<';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function installCompletion(userHome = os.homedir(), zshHome = process.env.ZDOTDIR || userHome) {
  const dir = path.join(userPrefix(userHome), 'completions');
  fs.mkdirSync(dir, { recursive: true });
  for (const [shell, rc] of [['bash', path.join(userHome, '.bashrc')], ['zsh', path.join(zshHome, '.zshrc')]]) {
    const file = path.join(dir, `${shell}.sh`);
    fs.writeFileSync(file, completionScript(shell));
    const original = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    const block = `${start}\nexport PATH=${quote(path.join(userHome, '.local', 'bin'))}:"$PATH"\n[ -r ${quote(file)} ] && . ${quote(file)}\n${end}`;
    const from = original.indexOf(start), to = original.indexOf(end, from);
    if (from >= 0 && to < 0) throw new Error(`Incomplete fluid completion block in ${rc}`);
    const result = from < 0 ? `${original}${original.endsWith('\n') || !original ? '' : '\n'}\n${block}\n`
      : original.slice(0, from) + block + original.slice(to + end.length);
    fs.mkdirSync(path.dirname(rc), { recursive: true });
    fs.writeFileSync(rc, result);
  }
}
export function removeCompletion(userHome = os.homedir(), zshHome = process.env.ZDOTDIR || userHome) {
  for (const rc of [path.join(userHome, '.bashrc'), path.join(zshHome, '.zshrc')]) {
    if (!fs.existsSync(rc)) continue;
    const original = fs.readFileSync(rc, 'utf8'), from = original.indexOf(start), to = original.indexOf(end, from);
    if (from < 0) continue;
    if (to < 0) throw new Error(`Incomplete fluid completion block in ${rc}`);
    const tail = to + end.length;
    fs.writeFileSync(rc, original.slice(0, from) + original.slice(tail + (original[tail] === '\n' ? 1 : 0)));
  }
  const directory = userPrefix(userHome);
  fs.rmSync(path.join(directory, 'completions'), { recursive: true, force: true });
  try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
}
