// Check the actual disk image, not just the pre-packaging application directory.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.platform !== 'darwin') throw new Error('Disk-image checks require macOS.');
if (!process.argv[2]) throw new Error('Pass one or more built .dmg files.');
for (const file of process.argv.slice(2)) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-image-'));
  let attached = false;
  try {
    execFileSync('hdiutil', ['verify', file], { stdio: 'pipe' });
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file], { stdio: 'pipe' });
    attached = true;
    const app = path.join(mount, 'easy-switch.app');
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--strict', path.join(app, 'Contents', 'Resources', 'codex', 'codex')], { stdio: 'inherit' });
    console.log(`${path.basename(file)}: disk-image integrity and application signatures verified.`);
  } finally {
    if (attached) execFileSync('hdiutil', ['detach', mount], { stdio: 'pipe' });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}
