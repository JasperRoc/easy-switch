import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startWindowsUpdate } from '../desktop/updater.js';

const powershell = process.env.SWITCH_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);
test('Windows update worker handles installer results, exact paths and startup confirmation in PowerShell', { skip: !powershell, timeout: 30000 }, async () => {
  const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-update.test.ps1', import.meta.url)),
    '-Worker', fileURLToPath(new URL('../desktop/windows-update.ps1', import.meta.url))], { windowsHide: true, timeout: 25000 });
  for (const scenario of ['success', 'installer-failure', 'version-unchanged', 'startup-unconfirmed', 'corrupt-package', 'parent-running']) assert.ok(stdout.includes('PASS ' + scenario), stdout);
});

test('PowerShell opens a job through a path with spaces, Unicode and apostrophes and returns its preflight error', { skip: !powershell, timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "用户's ‘updates’");
  fs.mkdirSync(directory);
  const staged = path.join(directory, 'package.exe');
  fs.writeFileSync(staged, 'corrupt fixture');
  await assert.rejects(startWindowsUpdate({
    current: process.execPath, staged, receipt: path.join(directory, 'pending.json'), parent: process.pid,
    size: fs.statSync(staged).size, sha256: '0'.repeat(64), token: 'launch-fixture',
  }, (_file, args, options) => spawn(powershell, args, options)), /Update package SHA-256 verification failed/);
  assert.match(fs.readFileSync(path.join(directory, 'last-error.txt'), 'utf8'), /SHA-256 verification failed/);
});
