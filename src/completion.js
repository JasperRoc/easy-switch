import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState, providerOrder } from './store.js';

export function candidates(words, root) {
  let aliases = [];
  try { aliases = providerOrder(readState(root)); } catch { /* Completion also works before setup. */ }
  const prefix = words.at(-1) || '';
  const before = words.slice(0, -1);
  let options = [];
  if (!before.length) options = ['add', 'list', 'current', 'order', 'update', 'service', 'help', ...aliases];
  else if (before.length === 1 && before[0] === 'add') options = ['api', 'account'];
  else if (before.length === 1 && before[0] === 'service') options = ['status', 'restart', 'uninstall'];
  else if (before[0] === 'order') options = aliases.filter(alias => !before.slice(1).includes(alias));
  return options.filter(option => option.startsWith(prefix));
}
export function completionScript(shell) {
  if (shell === 'bash') return `_easy_switch_complete() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && COMPREPLY+=("$candidate")
  done < <(command switch __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -F _easy_switch_complete switch
`;
  return `autoload -Uz compinit
(( $+functions[compdef] )) || compinit
_easy_switch_complete() {
  local -a candidates
  candidates=("\${(@f)$(command switch __complete "\${words[@]:1:$((CURRENT - 1))}" 2>/dev/null)}")
  compadd -- "\${candidates[@]}"
}
compdef _easy_switch_complete switch
`;
}
const start = '# >>> easy-switch completion >>>';
const end = '# <<< easy-switch completion <<<';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function installCompletion(userHome = os.homedir(), zshHome = process.env.ZDOTDIR || userHome) {
  const dir = path.join(userHome, '.local', 'share', 'easy-switch', 'completions');
  fs.mkdirSync(dir, { recursive: true });
  for (const [shell, rc] of [['bash', path.join(userHome, '.bashrc')], ['zsh', path.join(zshHome, '.zshrc')]]) {
    const file = path.join(dir, `${shell}.sh`);
    fs.writeFileSync(file, completionScript(shell));
    const original = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    const block = `${start}\n[ -r ${quote(file)} ] && . ${quote(file)}\n${end}`;
    const from = original.indexOf(start), to = original.indexOf(end, from);
    if (from >= 0 && to < 0) throw new Error(`Incomplete easy-switch completion block in ${rc}`);
    const result = from < 0 ? `${original}${original.endsWith('\n') || !original ? '' : '\n'}\n${block}\n`
      : original.slice(0, from) + block + original.slice(to + end.length);
    fs.mkdirSync(path.dirname(rc), { recursive: true });
    fs.writeFileSync(rc, result);
  }
}
