import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { editOrder } from '../src/order.js';

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let screen = '';
  const output = new Writable({ write(chunk, encoding, done) { screen += chunk; done(); } });
  output.isTTY = true;
  output.rows = 6;
  return { input, output, screen: () => screen };
}
test('keyboard editor moves items, saves, and restores terminal', async () => {
  const { input, output, screen } = terminal();
  const aliases = ['a', 'b', 'c'];
  const pending = editOrder(aliases, input, output);
  input.write('\x1b[B'); // select b
  input.write('\x1b[1;2A'); // Shift+Up: move b above a
  input.write('\r');
  assert.deepEqual(await pending, ['b', 'a', 'c']);
  assert.deepEqual(aliases, ['a', 'b', 'c']);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.ok(screen().endsWith('\x1b[?25h\x1b[?1049l'));
});
test('keyboard editor cancellation discards changes and restores raw mode', async () => {
  const { input, output } = terminal();
  input.isRaw = true;
  const pending = editOrder(['a', 'b'], input, output);
  input.write('J');
  input.write('\x03'); // Ctrl+C
  assert.equal(await pending, null);
  assert.equal(input.isRaw, true);
});
