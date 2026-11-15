// Download pinned official helper packages at build time, never on first launch.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const version = '0.165.0';
const targets = process.argv.slice(2);
if (!targets.length) targets.push(`${process.platform}-${process.arch}`);
const triples = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' };
const nativeTarget = `${process.platform}-${process.arch}`;
for (const target of new Set([...targets, nativeTarget])) {
  if (!triples[target]) throw new Error(`Unsupported desktop target: ${target}`);
  const dest = path.resolve('.desktop-cache', `codex-${target}`);
  const exe = target.startsWith('win32') ? 'codex.exe' : 'codex';
  const marker = path.join(dest, 'version.txt');
  if (fs.existsSync(path.join(dest, exe)) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === version) continue;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-helper-'));
  try {
    console.log(`Preparing official Codex ${version} for ${target}…`);
    // npm-cli.js avoids Windows shell quoting and npm.cmd spawning differences.
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run this script through npm run desktop:prepare.');
    const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', `@openai/codex@${version}-${target}`, '--json', '--pack-destination', temp], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
    execFileSync('tar', ['-xzf', path.join(temp, packed[0].filename), '-C', temp]);
    const vendor = path.join(temp, 'package', 'vendor', triples[target]);
    fs.mkdirSync(dest, { recursive: true });
    // Only the CLI executable is needed for device login, model metadata and account quota/reset methods.
    fs.copyFileSync(path.join(vendor, 'bin', exe), path.join(dest, exe));
    if (!target.startsWith('win32')) fs.chmodSync(path.join(dest, exe), 0o755);
    fs.copyFileSync(path.join(__dirname, '..', 'docs', 'CODEX-LICENSE'), path.join(dest, 'LICENSE'));
    fs.writeFileSync(marker, version);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
// Package sanitized metadata from the matching official helper. This enriches
// exact provider IDs only and avoids a second Codex process on Windows startup.
const native = path.resolve('.desktop-cache', `codex-${nativeTarget}`);
const metadataFile = path.join(native, 'model-metadata.json');
let metadata;
try { metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); } catch {}
if (metadata?.version !== version) {
  const moduleURL = pathToFileURL(path.join(__dirname, '..', 'src', 'catalog.js')).href;
  const script = `import {codexModels} from ${JSON.stringify(moduleURL)}; const models=await codexModels({binary:process.argv[1],includeHidden:true}); process.stdout.write(JSON.stringify({version:${JSON.stringify(version)},models}));`;
  metadata = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, path.join(native, process.platform === 'win32' ? 'codex.exe' : 'codex')], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }));
}
for (const target of targets) fs.writeFileSync(path.resolve('.desktop-cache', `codex-${target}`, 'model-metadata.json'), JSON.stringify(metadata));
