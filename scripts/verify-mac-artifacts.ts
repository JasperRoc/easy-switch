// Check the actual disk image, not just the pre-packaging application directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (process.platform !== 'darwin') throw new Error('Disk-image checks require macOS.');
if (!process.argv[2]) throw new Error('Pass one or more built .dmg files.');
for (const file of process.argv.slice(2)) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-image-'));
  let attached = false;
  try {
    execFileSync('hdiutil', ['verify', file], { stdio: 'pipe' });
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file], { stdio: 'pipe' });
    attached = true;
    const app = path.join(mount, 'fluid.app');
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--strict', path.join(app, 'Contents', 'Resources', 'worker', 'node')], { stdio: 'inherit' });
    if (process.env.APPLE_SIGNING_IDENTITY && process.env.APPLE_SIGNING_IDENTITY !== '-') {
      execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
      execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
    }
    console.log(`${path.basename(file)}: disk-image integrity and application signatures verified.`);
  } finally {
    if (attached) execFileSync('hdiutil', ['detach', mount], { stdio: 'pipe' });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}
