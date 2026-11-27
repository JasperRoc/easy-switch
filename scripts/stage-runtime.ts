import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(__dirname, '..');
const [out = path.join(project, '.build'), target] = process.argv.slice(2);
const copy = (name: string, options: fs.CopySyncOptions = {}) => fs.cpSync(path.join(project, name), path.join(out, name), options);
copy('package.json');
for (const name of ['codex-model-metadata.json', 'sync-writer.ps1']) copy('src/' + name);
if (target === 'cli') {
  for (const name of ['README.md', 'CONTRIBUTING.md', 'install.sh', 'docs']) copy(name, { recursive: true });
} else {
  copy('test/reference/sse.wasm');
  copy('desktop', { recursive: true, filter: file => !/\.c?ts$|\/\.DS_Store$/.test(file) });
}
