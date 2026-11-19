import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const powershell = process.env.SWITCH_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);
test('Windows update worker handles installer results, exact paths and startup confirmation in PowerShell', { skip: !powershell, timeout: 30000 }, async () => {
  const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-update.test.ps1', import.meta.url)),
    '-Worker', fileURLToPath(new URL('../desktop/windows-update.ps1', import.meta.url))], { windowsHide: true, timeout: 25000 });
  for (const scenario of ['success', 'installer-failure', 'version-unchanged', 'startup-unconfirmed', 'corrupt-package', 'parent-running']) assert.ok(stdout.includes('PASS ' + scenario), stdout);
});
