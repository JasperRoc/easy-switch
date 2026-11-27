import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const root = path.resolve(__dirname, '..');
const crate = path.join(root, 'rust', 'desktop');
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const [platform, requestedArch] = process.argv.slice(2);
const arch = requestedArch || process.arch;
const targets = { darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }, win32: { x64: 'x86_64-pc-windows-msvc' } };
const host = { mac: 'darwin', win: 'win32' }[platform];
const target = targets[host]?.[arch];
if (!target || process.platform !== host) throw new Error('Build on macOS for macOS, or on Windows x64 for Windows.');
if (JSON.parse(fs.readFileSync(path.join(crate, 'tauri.conf.json'), 'utf8')).version !== version ||
    !fs.readFileSync(path.join(crate, 'Cargo.toml'), 'utf8').includes(`version = "${version}"`)) {
  throw new Error('The npm, Rust and Tauri versions must match.');
}

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')]);
run(process.execPath, ['scripts/stage-runtime.ts']);
run(process.execPath, ['scripts/prepare-native.ts', `${host}-${arch}`]);
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-';
const signedMac = platform === 'mac' && signingIdentity !== '-';
if (signedMac) {
  const passwordAuth = process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID;
  const keyAuth = process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY_PATH;
  if (!passwordAuth && !keyAuth) throw new Error('Developer ID releases require Apple notarization credentials.');
  // Resources are copied unchanged by Tauri; sign the private JIT runtime before bundling.
  run('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements',
    path.join(crate, 'node.entitlements.plist'), '--sign', signingIdentity, path.join(root, '.build', 'worker', 'node')]);
}
const macConfig = platform === 'mac' ? ['--config', JSON.stringify({ bundle: { macOS: { signingIdentity } } })] : [];
const cargoTarget = path.join(crate, 'target');
const signingEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith('APPLE_') || value?.trim()));
const bundleOptions = { cwd: crate, env: { ...signingEnvironment, ...(platform === 'mac' ? { APPLE_SIGNING_IDENTITY: signingIdentity } : {}), CARGO_TARGET_DIR: cargoTarget } };
run(process.execPath, [cli, 'build', '--target', target, '--features', 'desktop', ...macConfig, '--bundles', platform === 'mac' ? 'app' : 'nsis', '--', '--locked'], bundleOptions);
if (platform === 'mac') {
  // Hosted macOS runners can briefly keep a completed DMG's volume busy.
  // Retry packaging separately; compilation and signature failures remain final.
  const args = [cli, 'bundle', '--target', target, '--features', 'desktop', ...macConfig, '--bundles', 'app,dmg'];
  try { run(process.execPath, args, bundleOptions); }
  catch {
    console.log('Retrying macOS disk image packaging.');
    run(process.execPath, args, bundleOptions);
  }
}

const bundles = path.join(cargoTarget, target, 'release', 'bundle');
const destination = path.join(root, 'dist', `native-${version}`);
fs.mkdirSync(destination, { recursive: true });
function copyBundle(kind, extension) {
  const folder = path.join(bundles, kind);
  const file = fs.readdirSync(folder).find(name => name.startsWith(`fluid_${version}_`) && name.endsWith(extension));
  if (!file) throw new Error(`Missing native release bundle for ${target}.`);
  fs.copyFileSync(path.join(folder, file), path.join(destination, `fluid-${version}-${platform}-${arch}${extension}`));
}
if (platform === 'mac') {
  const app = path.join(bundles, 'macos', 'fluid.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (signedMac) {
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  } else console.log('Preview build: ad hoc signed, without Apple notarization. First launch requires approval.');
  const zip = path.join(destination, `fluid-${version}-mac-${arch}.zip`);
  fs.rmSync(zip, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  copyBundle('dmg', '.dmg');
} else copyBundle('nsis', '.exe');
console.log(destination);
