import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWindowsUpdate } from '../desktop/updater.js';

const bundled = process.env.SWITCH_TEST_WINDOWS_UPDATE_HELPER;
const skip = process.platform !== 'win32' || !bundled;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-switch 用户's update "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, parent: process.pid, current: process.execPath, staged: path.join(root, 'installer.exe'),
    receipt: path.join(root, 'pending.json'), version: '1.0.0', token: 'native-fixture' };
}

test('the bundled Windows helper reports a missing installer before the app exits', { skip, timeout: 10000 }, async t => {
  const job = fixture(t);
  await assert.rejects(startWindowsUpdate(job, bundled), /The Windows update files are unavailable/);
  assert.equal(fs.existsSync(path.join(job.root, 'helper-ready.txt')), false);
});

test('the bundled Windows helper waits for the running process before touching the installer', { skip, timeout: 15000 }, async t => {
  const job = fixture(t);
  fs.writeFileSync(job.staged, 'installer fixture');
  let child;
  try {
    await startWindowsUpdate(job, bundled, (file, args, options) => {
      child = spawn(file, args, options);
      return child;
    });
    assert.equal(fs.readFileSync(path.join(job.root, 'helper-ready.txt'), 'utf8'), job.token);
    assert.equal(child.exitCode, null);
    assert.equal(fs.existsSync(path.join(job.root, 'last-error.txt')), false);
    assert.equal(fs.readFileSync(job.staged, 'utf8'), 'installer fixture');
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.ref();
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  }
});
