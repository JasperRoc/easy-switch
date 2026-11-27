import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home, init } from './store.js';
import { createReauth } from './auth.js';
import { codexBinary, installedCodexVersion } from './codex-binary.js';
import { codexModelMetadata } from './catalog.js';
import { networkEnvironment } from './network.js';
import { activateClaude, claudeCompactWindows, restoreClaude } from './claude-config.js';
import { claudeHome } from './claude-auth.js';
import { claudeModelEnvironment } from './claude-models.js';
import { SessionSync } from './task-sync.js';
import { serveWorker } from './worker-transport.js';

const root = home(), claudeRoot = path.join(root, 'claude');
const record = path.join(root, 'claude-session.json');
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
Object.assign(process.env, networkEnvironment(root));
const taskSync = new SessionSync({ root, codexHome, claudeHome: claudeHome(), binary: codexBinary });
let changed: () => void;
const reauth = createReauth({ binary: codexBinary, changed: () => changed?.() });

changed = serveWorker(async (action, payload) => {
  switch (action) {
    case 'attach': return;
    case 'service-init':
    case 'sync-claude-context': {
      if (action === 'service-init') {
        init(root);
        restoreClaude(record);
      } else if (!fs.existsSync(record)) return;
      const state = init(claudeRoot);
      if (state.active && state.providers[state.active]) {
        activateClaude(root, claudeHome(), Number(process.env.SWITCH_PORT), state.token,
          claudeModelEnvironment(state.providers[state.active]), claudeCompactWindows(state.providers[state.active]));
      }
      return;
    }
    case 'service-start': taskSync.start(); return;
    case 'service-stop': await taskSync.close(); restoreClaude(record); return;
    case 'installed-version': return installedCodexVersion();
    case 'codex-metadata': return codexModelMetadata(codexBinary);
    case 'auth-required': {
      if (Object.values(init(root).providers).some(provider => provider.accountHome === payload.accountHome))
        return reauth.prompt(payload);
      return;
    }
    default: throw new Error('Unsupported service action.');
  }
}, {
  retained: () => reauth.pending(),
  close: async () => { reauth.close(); await taskSync.close(); },
  parallel: new Set(['auth-required', 'installed-version', 'codex-metadata']),
});
