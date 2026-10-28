// Internal systemd entry point.
import { home, init } from './store.js';
import { createProxy } from './proxy.js';
import { networkEnvironment } from './network.js';

try {
  const root = home();
  const port = Number(process.env.SWITCH_PORT || 18345);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SWITCH_PORT must be 1–65535');
  init(root);
  Object.assign(process.env, networkEnvironment(root));
  const server = createProxy({ root });
  server.on('error', () => { console.error('Proxy failed to start; check whether the port is in use.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
