import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { desktopActivity } = createRequire(import.meta.url)('../desktop/activity.cjs');

function fixture() {
  const window = new EventEmitter(), powerMonitor = new EventEmitter(), timers = new Map(), passes = [], foreground = [];
  let visible = true, minimized = false, sequence = 0;
  window.isVisible = () => visible; window.isMinimized = () => minimized;
  const activity = desktopActivity({ window, powerMonitor, refresh: visible => passes.push(visible), foreground: visible => foreground.push(visible),
    setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id) });
  const emit = event => {
    if (event === 'show') visible = true;
    if (event === 'hide') visible = false;
    if (event === 'minimize') minimized = true;
    if (event === 'restore') minimized = false;
    window.emit(event);
  };
  const tick = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); };
  return { activity, window, powerMonitor, timers, passes, foreground, emit, tick };
}
test('hidden or minimized windows use slow maintenance without foreground work; reopening refreshes immediately', () => {
  const f = fixture(); assert.deepEqual(f.passes, [true]);
  assert.equal([...f.timers.values()][0].delay, 1500);
  f.emit('hide'); assert.equal(f.foreground.at(-1), false); assert.equal(f.passes.at(-1), false);
  assert.equal([...f.timers.values()][0].delay, 30000);
  f.tick(); assert.equal(f.passes.at(-1), false); assert.equal(f.timers.size, 1);
  f.emit('show'); assert.equal(f.foreground.at(-1), true); assert.equal(f.passes.at(-1), true);
  f.emit('minimize'); assert.equal(f.activity.visible(), false); assert.equal([...f.timers.values()][0].delay, 30000);
  f.emit('restore'); assert.equal(f.activity.visible(), true); f.activity.stop();
});
test('sleep and screen lock cancel maintenance until both states clear, without accumulating timers or handlers', () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++) {
    f.powerMonitor.emit('lock-screen'); const count = f.passes.length;
    f.powerMonitor.emit('suspend'); f.powerMonitor.emit('resume');
    assert.equal(f.passes.length, count); assert.equal(f.timers.size, 0);
    assert.equal(f.activity.paused(), true); assert.equal(f.foreground.at(-1), false);
    f.powerMonitor.emit('unlock-screen'); assert.equal(f.timers.size, 1);
    f.emit('hide'); f.emit('show'); assert.equal(f.timers.size, 1);
  }
  assert.equal(f.powerMonitor.listenerCount('suspend'), 1); assert.equal(f.window.listenerCount('show'), 1);
  f.activity.stop(); assert.equal(f.timers.size, 0); assert.equal(f.foreground.at(-1), false);
  const count = f.passes.length; f.powerMonitor.emit('resume'); f.emit('show'); assert.equal(f.passes.length, count);
  assert.equal(f.powerMonitor.listenerCount('suspend'), 0); assert.equal(f.window.listenerCount('show'), 0);
});
