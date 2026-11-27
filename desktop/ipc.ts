import type { Client } from '../src/store.js';
import type { McpSettings, parseMcpEntry } from '../src/mcp-settings.js';
import type { SkillSettings } from '../src/skill-settings.js';
import type { TaskSync } from '../src/task-sync.js';
import type { AddAPI, DesktopController, EditProvider, Preferences } from './controller.js';
import type { DesktopUpdater } from './updater.js';
import type { Language } from './i18n.js';

type ControllerState = ReturnType<DesktopController['snapshot']>;
type MutationState = ControllerState & { error: string; version: string };
type UpdateState = ReturnType<DesktopUpdater['snapshot']>;
export type DesktopTab = 'providers' | 'settings' | 'updates';
export type DesktopSnapshot = Omit<MutationState, 'clients'> & {
  update: UpdateState;
  menuBarHidden: boolean;
  language: Language;
  theme: NonNullable<Preferences['theme']>;
  dark: boolean;
  platform: NodeJS.Platform;
  loginItem: boolean;
  activeRequests: number;
  clients: Record<Client, ControllerState['clients'][string] & { activeRequests: number }>;
  reauth?: { client: Client; alias: string };
};
import type { UsageFilter, UsageStats } from '../src/usage-stats.js';

type SyncState = ReturnType<TaskSync['snapshot']>;
type McpRows = ReturnType<McpSettings['list']>;
type SkillRows = Awaited<ReturnType<SkillSettings['list']>>;

interface Commands {
  'usage-stats': [UsageFilter, UsageStats];
  state: [undefined, DesktopSnapshot];
  client: [Client, MutationState];
  switch: [string, MutationState];
  order: [string[], MutationState];
  edit: [EditProvider, MutationState];
  remove: [string, MutationState];
  'add-api': [AddAPI, MutationState];
  login: [string, MutationState];
  'login-code': [string, MutationState];
  'import-login': [string, MutationState];
  'existing-login': [undefined, Awaited<ReturnType<DesktopController['existingLogin']>>];
  models: [string, Awaited<ReturnType<DesktopController['models']>>];
  'reset-cards': [string, Awaited<ReturnType<DesktopController['resetCards']>>];
  'consume-reset': [Parameters<DesktopController['consumeReset']>[0], Awaited<ReturnType<DesktopController['consumeReset']>>];
  start: [undefined, MutationState];
  stop: [undefined, MutationState];
  routing: [Parameters<DesktopController['setRouting']>[0], MutationState];
  autostart: [boolean, MutationState];
  preferences: [Preferences, MutationState];
  'open-login': [undefined, null];
  updates: [undefined, UpdateState];
  'update-download': [undefined, UpdateState];
  'update-install': [undefined, UpdateState | null];
  'update-reveal': [undefined, null];
  star: [undefined, null];
  quit: [undefined, null];
  uninstall: [undefined, null];
  'sync-client': [Client, SyncState];
  'sync-state': [undefined, SyncState];
  'sync-tasks': [undefined, SyncState];
  'sync-configure': [Parameters<TaskSync['configure']>[0], SyncState];
  'sync-select': [Parameters<TaskSync['select']>[0], SyncState];
  'sync-remove-remote': [Parameters<TaskSync['removeRemote']>[0], SyncState];
  'sync-now': [undefined, SyncState];
  'sync-resolve': [Parameters<TaskSync['resolve']>[0], SyncState];
  'sync-guide': [Language, null];
  'mcp-settings': [undefined, McpRows];
  'mcp-details': [Parameters<McpSettings['details']>[0], ReturnType<McpSettings['details']>];
  'mcp-change': [Parameters<McpSettings['change']>[0], McpRows];
  'mcp-parse': [{ text: string; name: string; client: Client }, ReturnType<typeof parseMcpEntry>];
  'skill-settings': [undefined, SkillRows];
  'skill-discover': [{ kind: 'folder' | 'zip' | 'github'; source?: string }, Awaited<ReturnType<SkillSettings['discover']>> | null];
  'skill-import': [Parameters<SkillSettings['import']>[0], SkillRows];
  'skill-update-all': [undefined, Awaited<ReturnType<SkillSettings['updateAll']>>];
  'skill-change': [Parameters<SkillSettings['change']>[0], SkillRows];
  'skill-discard': [undefined, null];
  'skill-cancel': [undefined, null];
}

export type DesktopAction = keyof Commands;
export type DesktopPayload<A extends DesktopAction> = Commands[A][0];
export type DesktopResult<A extends DesktopAction> = Commands[A][1];
export type DesktopArgs<A extends DesktopAction> =
  [DesktopPayload<A>] extends [undefined] ? [payload?: undefined] : [payload: DesktopPayload<A>];

export type DesktopRequest = {
  [A in DesktopAction]: [action: A, payload: DesktopPayload<A>]
}[DesktopAction];

export interface DesktopBridge {
  call<A extends DesktopAction>(action: A, ...args: DesktopArgs<A>): Promise<DesktopResult<A>>;
  onChange(callback: (state?: DesktopSnapshot) => void): void;
  onTab(callback: (tab: DesktopTab) => void): void;
  onShow(callback: () => void): void;
  retainWindow(value: boolean): void;
}

declare global {
  interface Window { fluid: DesktopBridge; }
}
