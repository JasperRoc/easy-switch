import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { choose } from '../src/menu.js';

test('interactive menu selects with the keyboard and restores terminal state on success or cancellation', async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = value => { input.isRaw = value; };
    let screen = ''; const output = new Writable({ write(chunk, _encoding, done) { screen += chunk; done(); } }); output.isTTY = true;
    const result = choose('Client', [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }], input, output);
    input.write('\x1b[B'); input.write(cancel ? '\x03' : '\r');
    assert.equal(await result, cancel ? null : 'claude');
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
    assert.ok(screen.endsWith('\x1b[?25h\x1b[?1049l'));
  }
});
