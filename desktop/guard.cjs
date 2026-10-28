// Independent Node process: IPC disconnection means the GUI exited or crashed.
(async () => {
  const { restoreSession } = await import('./config.js');
  let disarmed = false;
  process.on('message', message => {
    if (message?.type === 'disarm') { disarmed = true; process.exit(0); }
  });
  process.on('disconnect', () => {
    if (!disarmed) {
      try { restoreSession(process.argv[2]); }
      catch { /* Keep the recovery record; the next launch reports the conflict. */ }
    }
    process.exit(0);
  });
  process.send?.({ type: 'ready' });
})().catch(() => process.exit(1));
