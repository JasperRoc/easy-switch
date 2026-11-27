import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
const { version: appVersion } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const root = path.resolve(__dirname, '..');
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const version = 'v22.23.5';
const platforms = {
  'darwin-arm64': ['node-v22.23.5-darwin-arm64.tar.gz', 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d'],
  'darwin-x64': ['node-v22.23.5-darwin-x64.tar.gz', 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422'],
  'win32-x64': ['win-x64/node.exe', '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'],
};
const win = target.startsWith('win32');
const build = path.join(root, '.build');
const webview = path.join(build, 'webview');
const worker = path.join(build, 'worker');
const downloads = path.join(root, '.desktop-cache', 'native-downloads');
const dependency = name => path.join(root, 'node_modules', ...name.split('/'));

async function sha256(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function runtime() {
  const [file, sha] = platforms[target] || [];
  if (!file) throw new Error(`Unsupported native desktop target ${target}`);
  const cache = path.join(downloads, win ? `node-${version}-win32-x64.exe` : file);
  if (!fs.existsSync(cache) || await sha256(cache) !== sha) {
    fs.mkdirSync(downloads, { recursive: true });
    const partial = cache + '.partial';
    try {
      console.log(`Downloading the private feature runtime for ${target}`);
      const response = await fetch(`https://nodejs.org/dist/${version}/${file}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('Unable to download the private feature runtime.');
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), fs.createWriteStream(partial));
      if (await sha256(partial) !== sha) throw new Error('Private runtime checksum verification failed.');
      fs.renameSync(partial, cache);
    } finally { fs.rmSync(partial, { force: true }); }
  }
  if (win) fs.copyFileSync(cache, path.join(worker, 'node.exe'));
  else {
    execFileSync('tar', ['-xzf', cache, '--strip-components=2', '-C', worker, file.replace(/\.tar\.gz$/, '') + '/bin/node']);
    fs.chmodSync(path.join(worker, 'node'), 0o755);
  }
}

async function main() {
  for (const directory of [webview, worker]) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
  }
  const copy = (from: string, to: string, filter?: fs.CopySyncOptions['filter']) => fs.cpSync(from, to, { recursive: true, filter });
  const web = path.join(webview, 'desktop');
  fs.mkdirSync(web);
  for (const name of ['index.html', 'style.css', 'native-bridge.js', 'renderer.js', 'dom.js', 'i18n.js', 'release-notes.js', 'task-sync.js', 'extensions.js', 'usage-stats.js'])
    fs.copyFileSync(path.join(build, 'desktop', name), path.join(web, name));
  fs.mkdirSync(path.join(web, 'assets'));
  for (const name of ['icon.png', 'codex-mark.png', 'claude-mark.png', 'ui.svg'])
    fs.copyFileSync(path.join(root, 'desktop', 'assets', name), path.join(web, 'assets', name));
  fs.mkdirSync(path.join(webview, 'src'));
  for (const name of ['claude-models.js', 'plans.js', 'sync-url.js']) fs.copyFileSync(path.join(build, 'src', name), path.join(webview, 'src', name));
  const runtimeSources = new Set(['worker.js', 'image-browser.js', 'account-images.js', 'native-images.js', 'web-image-page.js',
    'controller.js', 'config.js', 'network.js', 'i18n.js', 'runtime.js', 'reset-credits.js', 'usage.js', 'import.js', 'uninstall.js',
    'updater.js', 'preferences-access.ps1']);
  copy(path.join(build, 'src'), path.join(worker, 'src'), file => fs.statSync(file).isDirectory() ||
    /\.(?:js|json|ps1)$/.test(file) && !['cli.js', 'setup.js', 'update.js', 'service-worker.js', 'order.js'].includes(path.basename(file)) &&
    fs.existsSync(path.join(root, 'src', path.basename(file).replace(/\.js$/, '.ts'))));
  copy(path.join(build, 'desktop'), path.join(worker, 'desktop'), file => path.basename(file) === 'desktop' || runtimeSources.has(path.basename(file)));
  fs.writeFileSync(path.join(worker, 'package.json'), JSON.stringify({ type: 'module', version: appVersion }) + '\n');
  for (const name of ['smol-toml', 'undici', 'yauzl', 'pend']) copy(dependency(name), path.join(worker, 'node_modules', name));
  const icons = path.join(build, 'icons');
  if (!fs.existsSync(path.join(icons, 'icon.ico')) || !fs.existsSync(path.join(icons, 'icon.icns'))) {
    const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    execFileSync(process.execPath, [cli, 'icon', path.join(root, 'desktop', 'assets', 'icon.png'), '--output', icons], { cwd: path.join(root, 'rust', 'desktop'), stdio: 'inherit' });
  }
  await runtime();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
