// UI polling is useful only while the window can be seen. Keep a lightweight
// background pass for tray routing changes and session-cache cleanup.
function desktopActivity({ window, powerMonitor, refresh, foreground, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, sleeping = false, locked = false, stopped = false;
  const paused = () => sleeping || locked;
  const visible = () => !paused() && window.isVisible() && !window.isMinimized();
  function tick() {
    timer = undefined;
    if (stopped || paused()) return;
    try { refresh(visible()); } finally {
      if (!stopped && !paused()) { timer = setTimer(tick, visible() ? 1500 : 30000); timer.unref?.(); }
    }
  }
  function changed() {
    clearTimer(timer); timer = undefined;
    foreground(visible());
    tick();
  }
  const handlers = [
    [window, 'show', changed], [window, 'hide', changed], [window, 'minimize', changed], [window, 'restore', changed],
    [powerMonitor, 'suspend', () => { sleeping = true; changed(); }],
    [powerMonitor, 'resume', () => { sleeping = false; changed(); }],
    [powerMonitor, 'lock-screen', () => { locked = true; changed(); }],
    [powerMonitor, 'unlock-screen', () => { locked = false; changed(); }],
  ];
  for (const [emitter, event, handler] of handlers) emitter.on(event, handler);
  changed();
  return { visible, paused, stop() {
    stopped = true; clearTimer(timer); foreground(false);
    for (const [emitter, event, handler] of handlers) emitter.removeListener(event, handler);
  } };
}
module.exports = { desktopActivity };
