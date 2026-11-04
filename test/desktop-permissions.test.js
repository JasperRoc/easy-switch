import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { protectDirectory, repairPreferencesAccess } from '../desktop/runtime.js';

test('Windows directory protection grants access first and never recursively disables child inheritance', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-permissions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], sid = 'S-1-5-21-100-200-300-1001';
  const run = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: command === 'whoami' ? `"test\\user","${sid}"` : '' }; };
  protectDirectory(directory, { platform: 'win32', run });
  assert.equal(calls[1].command, 'icacls'); assert.ok(calls[1].args.includes(`*${sid}:(OI)(CI)F`));
  assert.ok(calls[2].args.includes('/inheritance:r'));
  assert.ok(calls.every(call => !call.args.includes('/T')));
  const failed = [];
  assert.throws(() => protectDirectory(directory, { platform: 'win32', run(command, args) {
    failed.push(args); return command === 'whoami' ? { status: 0, stdout: sid } : { status: 1 };
  } }), /Unable to protect/);
  assert.equal(failed.length, 2, 'no inheritance is removed when granting access failed');
});
test('preference access repair is bounded and passes paths as data to the packaged PowerShell helper', () => {
  const file = "C:\\Users\\a'b$()\\.codex-switch\\desktop.json";
  for (const outcome of ['repaired', 'already-granted', 'different-owner', 'explicit-deny', 'unsupported-file']) {
    const result = repairPreferencesAccess(file, { platform: 'win32', run(command, args, options) {
      assert.equal(command, 'powershell.exe'); assert.equal(options.timeout, 5000); assert.equal(options.windowsHide, true);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.ok(script.includes(Buffer.from(file).toString('base64'))); assert.ok(!script.includes(file));
      return { status: 0, stdout: outcome + '\r\n' };
    } });
    assert.equal(result, outcome);
  }
  assert.equal(repairPreferencesAccess(file, { platform: 'win32', run: () => ({ status: 1, stderr: 'private diagnostics' }) }), 'failed');
  assert.equal(repairPreferencesAccess(file, { platform: 'win32', run: () => { throw new Error('unavailable'); } }), 'failed');
});
test('Windows can repeatedly protect and reopen saved preferences, and owner-only ACL recovery preserves bytes', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-native-permissions-')), file = path.join(directory, 'desktop.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  protectDirectory(directory);
  fs.writeFileSync(file, '{"language":"zh-CN","theme":"dark"}\n');
  const original = fs.readFileSync(file, 'utf8');
  protectDirectory(directory); assert.equal(fs.readFileSync(file, 'utf8'), original);
  const script = '$acl=Get-Acl -LiteralPath $env:SWITCH_PERMISSION_FILE; $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,"ChangePermissions,ReadPermissions,ReadAttributes","Allow")); Set-Acl -LiteralPath $env:SWITCH_PERMISSION_FILE -AclObject $acl';
  const changed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, SWITCH_PERMISSION_FILE: file }, encoding: 'utf8', windowsHide: true });
  assert.equal(changed.status, 0, 'the isolated ACL fixture must be created');
  assert.throws(() => fs.readFileSync(file), error => ['EPERM', 'EACCES'].includes(error.code));
  assert.equal(repairPreferencesAccess(file), 'repaired');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
