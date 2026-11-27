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
  const file = "C:\\Users\\a'b$()\\.fluid\\desktop.json";
  for (const outcome of ['repaired', 'already-granted', 'different-owner', 'explicit-deny', 'unsupported-file']) {
    const result = repairPreferencesAccess(file, { platform: 'win32', run(command, args, options) {
      assert.equal(command, 'powershell.exe'); assert.equal(options.timeout, 15000); assert.equal(options.windowsHide, true);
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
  const options = { encoding: 'utf8', windowsHide: true };
  const identity = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], options);
  const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
  assert.ok(sid, 'the Windows test account must have a SID');
  for (const args of [['/setowner', '*' + sid], ['/grant:r', `*${sid}:(WDAC,RC,RA)`], ['/inheritance:r']]) {
    const result = spawnSync('icacls', [file, ...args, '/Q'], options);
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  }
  assert.throws(() => fs.readFileSync(file), error => ['EPERM', 'EACCES'].includes(error.code));
  let diagnostics = '';
  const outcome = repairPreferencesAccess(file, { run(...args) {
    const result = spawnSync(...args);
    diagnostics = result.stderr || String(result.error || '');
    return result;
  } });
  assert.equal(outcome, 'repaired', diagnostics);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
