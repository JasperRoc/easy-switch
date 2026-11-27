import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const userPrefix = (userHome = os.homedir()) => path.join(userHome, '.local', 'share', 'fluid');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const marker = '# fluid managed launcher';
export function installLauncher(userHome = os.homedir()) {
  const file = path.join(userHome, '.local', 'bin', 'fd');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (fs.existsSync(file) && (!fs.statSync(file).isFile() || fs.statSync(file).size > 16384 || !fs.readFileSync(file, 'utf8').includes(marker))) {
    // Replace only our old npm symlink, never a different tool named fd.
    if (!fs.lstatSync(file).isSymbolicLink() || !fs.realpathSync(file).endsWith('/fluid/src/cli.js'))
      throw new Error(`${file} belongs to another tool; move it before installing fluid.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
}
export function removeLauncher(userHome = os.homedir()) {
  const file = path.join(userHome, '.local', 'bin', 'fd');
  if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size <= 16384 && fs.readFileSync(file, 'utf8').includes(marker)) fs.rmSync(file);
}
