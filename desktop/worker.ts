// On-demand desktop operations that share Codex and Claude's existing configuration formats.
import os from 'node:os';
import { usageStats } from '../src/usage-stats.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DesktopController } from './controller.js';
import { DesktopUpdater } from './updater.js';
import { normalizeLanguage, translate } from './i18n.js';
import { claudeDesktopPaths } from '../src/claude-desktop.js';
import { codexBinary, installedCodexVersion } from '../src/codex-binary.js';
import { codexModelMetadata } from '../src/catalog.js';
import { McpSettings, parseMcpEntry } from '../src/mcp-settings.js';
import { SkillSettings } from '../src/skill-settings.js';
import { createUpstreamFetch } from '../src/network.js';
import fs from 'node:fs';
import { removeDesktopData } from './uninstall.js';
import type { DesktopSnapshot } from './ipc.js';
import { serveWorker } from '../src/worker-transport.js';

const root = path.resolve(process.env.SWITCH_HOME || path.join(os.homedir(), '.fluid'));
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const version = process.env.FLUID_VERSION || JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const binary = () => codexBinary();
const repository = 'https://github.com/JasperRoc/fluid';
const port = Number(process.env.SWITCH_PORT || 18345);
let notify: () => void;
const changed = () => notify?.();
const controller = new DesktopController({ root, codexHome, claudeDesktop: claudeDesktopPaths(), binary, port, changed });
const updater = new DesktopUpdater({ root, current: version, changed });
const mcp = new McpSettings({ root, codexHome, binary });
const skills = new SkillSettings({ root, codexHome, claudeHome: controller.runtime.claudeHome, binary });
let skillsBusy = false;
let skillDownload: AbortController | null = null;
let nativeVersion: string | undefined;
let activeRequests = 0;
let codexRequests = 0, claudeRequests = 0;
let foreground = false;
const t = (key: string) => translate(normalizeLanguage(controller.preferences().language), key);

function openExternal(url: string) {
  const child = process.platform === 'darwin' ? spawn('/usr/bin/open', [url], { stdio: 'ignore' }) :
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
  return new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}

function snapshot(usage = false): DesktopSnapshot {
  const state = controller.snapshot({ usage });

  return { ...state, error: '', version, update: updater.snapshot(), menuBarHidden: false,
    language: normalizeLanguage(state.preferences.language || Intl.DateTimeFormat().resolvedOptions().locale),
    theme: state.preferences.theme || 'system', dark: state.preferences.theme === 'dark', platform: process.platform,
    clients: { codex: { ...state.clients.codex, activeRequests: codexRequests }, claude: { ...state.clients.claude, activeRequests: claudeRequests } },
    activeRequests, loginItem: !!state.preferences.startAtLogin };
}

async function call(action: string, payload, context) {
  await ready;
  nativeVersion = typeof context?.version === 'string' ? context.version : undefined;
  activeRequests = Number(context?.activeRequests) || 0;
  codexRequests = Number(context?.codexRequests) || 0;
  claudeRequests = Number(context?.claudeRequests) || 0;
  switch (action) {
    case 'attach':
      controller.runtime.attach();
      Object.assign(controller.runtime.routes, { codex: true, claude: true }, controller.preferences().routing);
      controller.usage.setPaused(true);
      controller.claudeUsage.setPaused(true);
      return snapshot();
    case 'network': return controller.network();
    case 'activate':
      await controller.runtime.stop();
      await controller.start();
      controller.usage.setPaused(true);
      controller.claudeUsage.setPaused(true);
      return snapshot();
    case 'recover': controller.runtime.restore(); return null;
    case 'uninstall-data': if (fs.existsSync(root)) await removeDesktopData(root); return null;
    case 'installed-version': return await installedCodexVersion();
    case 'codex-metadata': return codexModelMetadata(binary, payload?.version);
    case 'sync-claude-context': controller.runtime.syncClaude(); return null;
    case 'sync-client-settings': controller.runtime.syncTools(); controller.runtime.syncClaude(); return null;
    case 'sync-background':
      controller.taskSync.setPaused(false);
      controller.taskSync.closed = false;
      await controller.taskSync.run(); return controller.taskSync.snapshot();
    case 'account-image': {
      const { nativeAccountImage } = await import('./native-images.js');
      return nativeAccountImage(root, payload, controller.network());
    }
    case 'auth-required':
      if (payload.client === 'claude') {
        if (controller.claudeLogin?.alias !== payload.alias && ['starting', 'pending'].includes(controller.claudeLogin?.phase)) return null;
        await controller.startClaudeSignIn(payload.alias);
        return 'The Claude subscription needs sign-in in fluid.';
      } else {
        if (controller.login?.alias === payload.alias && ['starting', 'pending'].includes(controller.login.phase)) return controller.login.message;
        if (['starting', 'pending'].includes(controller.login?.phase)) return null;
        await controller.startLogin(payload.alias);
        return controller.login?.message;
      }
    case 'foreground':
      foreground = payload === true;
      refreshUsage();
      return null;
    case 'close':
      controller.usage.close(); controller.claudeUsage.close(); controller.reauth.close();
      controller.claudeLogin?.cancel?.();
      await controller.taskSync.close(); return null;
    case 'take-update':
      if (process.platform === 'win32') await updater.verifiedWindowsInstaller();
      return updater.takeNativeUpdate();
    case 'update-failed': updater.emit({ phase: 'ready', error: String(payload) }); return updater.snapshot();
  }
  let result;
      switch (action) {
        case 'usage-stats': return await usageStats(root, payload);
        case 'state': return snapshot(foreground);
        case 'client': result = controller.clientSelection(payload); break;
        case 'switch': result = controller.switchProvider(payload); break;
        case 'edit': result = controller.edit(payload); break;
        case 'remove': result = await controller.remove(payload); break;
        case 'order': result = controller.order(payload); break;
        case 'add-api': result = controller.addAPI(payload); break;
        case 'login': result = await controller.startLogin(payload); break;
        case 'login-code': result = controller.submitLogin(payload); break;
        case 'existing-login': return controller.existingLogin();
        case 'import-login': result = await controller.importLogin(payload); break;
        case 'models': return await controller.models(payload, nativeVersion);
        case 'reset-cards': return await controller.resetCards(payload);
        case 'consume-reset': return await controller.consumeReset(payload);
        case 'sync-client': {
          const result = await controller.taskSync.setClient(payload); controller.setPreferences({ syncClient: payload }); return result;
        }
        case 'sync-state': return controller.taskSync.snapshot();
        case 'sync-guide': await openExternal(`${repository}/blob/main/docs/task-sync${payload === 'zh-CN' ? '.zh-CN' : ''}.md`); return null;
        case 'sync-tasks': return await controller.taskSync.list();
        case 'sync-configure': return await controller.taskSync.configure(payload);
        case 'sync-select': return await controller.taskSync.select(payload);
        case 'sync-remove-remote': return await controller.taskSync.removeRemote(payload);
        case 'sync-resolve': return await controller.taskSync.resolve(payload);
        case 'sync-now': return await controller.taskSync.run();
        case 'mcp-settings': return mcp.list();
        case 'mcp-parse': return parseMcpEntry(payload.text, payload.name, payload.client);
        case 'mcp-details': return mcp.details(payload);
        case 'mcp-change': return await mcp.change(payload);
        case 'skill-settings': return await skills.list();
        case 'skill-cancel': skillDownload?.abort(); return null;
        case 'skill-discard':
        case 'skill-discover':
        case 'skill-import':
        case 'skill-update-all':
        case 'skill-change': {
          if (skillsBusy) throw new Error(t('extensionsBusy'));
          skillsBusy = true;
          try {
            if (action === 'skill-discard') { await skills.discard(); return null; }
            if (action === 'skill-change') return await skills.change(payload);
            if (action === 'skill-import') return await skills.import(payload);
            const kind = payload?.kind;
            if (action === 'skill-update-all' || kind === 'github') {
              const network = createUpstreamFetch(root);
              skillDownload = new AbortController();
              const options = { fetch: network.fetch, signal: skillDownload.signal };
              try {
                if (action === 'skill-update-all') return await skills.updateAll(options);
                return await skills.discover({ kind, source: payload.source, ...options });
              }
              finally { skillDownload = null; await network.close(); }
            }
            if (!['folder', 'zip'].includes(kind)) throw new Error(t('skillChooseSource'));
            return payload.source ? await skills.discover({ kind, source: payload.source }) : null;
          } finally { skillsBusy = false; }
        }
        case 'start': await controller.start(); refreshUsage(); result = snapshot(); break;
        case 'stop': await controller.stop(); result = snapshot(); break;
        case 'routing': await controller.setRouting(payload); refreshUsage(); result = snapshot(); break;
        case 'preferences': controller.setPreferences(payload); result = snapshot(); break;
        case 'autostart': controller.setPreferences({ startAtLogin: payload }); result = snapshot(); break;
        case 'open-login': {
          const url = controller.currentLogin?.url;
          if (url === 'https://auth.openai.com/codex/device' || /^https:\/\/(?:claude\.com|claude\.ai)\/(?:cai\/)?oauth\/authorize\?/.test(url || '')) await openExternal(url);
          return null;
        }
        case 'updates': return await updater.check();
        case 'update-download': await updater.download(); return updater.snapshot();
        case 'update-reveal': return await updater.verifiedWindowsInstaller();
        case 'update-install': return updater.snapshot();
        case 'star': await openExternal(repository); return null;
        default: throw new Error('Unsupported application action.');
      }

  return { ...result, error: '', version };
}

let usageTimer: ReturnType<typeof setInterval>;
function refreshUsage() {
  clearInterval(usageTimer);
  controller.usage.setPaused(!foreground || !controller.runtime.clientEnabled('codex'));
  controller.claudeUsage.setPaused(!foreground || !controller.runtime.clientEnabled('claude'));
  if (!foreground) return;
  snapshot(true);
  usageTimer = setInterval(() => snapshot(true), 60_000);
  usageTimer.unref();
}

const ready = controller.configureNetwork();
void ready.catch(() => {});
const readOnly = new Set(['usage-stats', 'state', 'models', 'existing-login', 'reset-cards', 'sync-state', 'mcp-settings', 'mcp-details', 'mcp-parse', 'skill-settings', 'installed-version', 'codex-metadata']);
notify = serveWorker(async (action, payload, context) => {
  const result = await call(action, payload, context);
  if (!readOnly.has(action) && !['attach', 'network', 'foreground', 'uninstall-data'].includes(action)) changed();
  return result;
}, {
  events: true,
  retained: () => !!(controller.reauth.pending() || ['starting', 'pending'].includes(controller.claudeLogin?.phase)
    || ['downloading', 'ready'].includes(updater.state.phase) || skills.preview),
  parallel: new Set(['skill-cancel', 'state', 'foreground', 'update-download', 'installed-version', 'codex-metadata', 'auth-required']),
  close: async () => {
    clearInterval(usageTimer);
    skillDownload?.abort();
    controller.reauth.close(); controller.claudeLogin?.cancel?.();
    controller.usage.close(); controller.claudeUsage.close();
    await controller.taskSync.close();
  },
});
