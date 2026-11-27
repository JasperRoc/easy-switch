import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const project = path.resolve(__dirname, '..');
const runtime = path.join(project, '.build');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2).map(value => value.replace(/\.ts$/, '.js'))], { cwd: runtime, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
