// Internal systemd entry point.
import { home, init } from './store.js';
import { createProxy } from './proxy.js';
import { networkEnvironment } from './network.js';
import path from 'node:path';
import { activateClaude, restoreClaude } from './claude-config.js';
import { claudeHome } from './claude-auth.js';

try {
  const root = home();
  const port = Number(process.env.SWITCH_PORT || 18345);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SWITCH_PORT must be 1–65535');
  init(root);
  restoreClaude(path.join(root, 'claude-session.json'));
  Object.assign(process.env, networkEnvironment(root));
  const server = createProxy({ root });
  server.on('error', () => { console.error('Proxy failed to start; check whether the port is in use.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  server.once('listening', () => {
    try {
      const state = init(path.join(root, 'claude'));
      if (Object.keys(state.providers).length) activateClaude(root, claudeHome(), port, state.token);
    } catch { console.error('Unable to configure Claude Code routing. Check its user settings.'); server.close(); process.exitCode = 1; }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    restoreClaude(path.join(root, 'claude-session.json'));
    server.close();
    server.closeAllConnections();
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
