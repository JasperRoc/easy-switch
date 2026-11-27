import type { DesktopBridge, DesktopSnapshot, DesktopTab } from './ipc.js';

type NativeWindow = Window & {
  __TAURI_INTERNALS__: { invoke<T>(command: string, args?: object): Promise<T> };
  fluidEvent: (event: 'change' | 'tab' | 'show', value?: DesktopTab) => void;
  fluidInitialTab?: DesktopTab;
};
const host = window as unknown as NativeWindow;
const invoke = <T>(command: string, args?: object) => host.__TAURI_INTERNALS__.invoke<T>(command, args)
  .catch(error => { throw error instanceof Error ? error : new Error(String(error)); });
const listeners: { change?: () => void; tab?: (tab: DesktopTab) => void; show?: () => void } = {};
let retained = false;
let savedTab = host.fluidInitialTab;
let changeFrame: number | undefined;

host.fluidEvent = (event, value) => {
  if (event === 'tab' && value) {
    if (listeners.tab) listeners.tab(value);
    else savedTab = value;
  } else if (event === 'change') listeners.change?.();
  else if (event === 'show') listeners.show?.();
};

const state = () => invoke<DesktopSnapshot>('desktop_call', { action: 'state', payload: !document.hidden }).then(value => {
  if (value.theme === 'system') value.dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return value;
});
const bridge: DesktopBridge = {
  async call(action, ...[payload]) {
    if (action === 'state') return await state() as never;
    return invoke('desktop_call', { action, payload });
  },
  onChange(callback) {
    listeners.change = () => {
      if (document.hidden || changeFrame !== undefined) return;
      changeFrame = requestAnimationFrame(() => { changeFrame = undefined; callback(); });
    };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', listeners.change);
  },
  onTab(callback) { listeners.tab = callback; if (savedTab) { callback(savedTab); savedTab = undefined; } },
  onShow(callback) { listeners.show = callback; },
  retainWindow(value) {
    if (retained === value) return;
    retained = value;
    void invoke('desktop_call', { action: 'retain-window', payload: value }).catch(() => {});
  },
};
window.fluid = bridge;

await import('./renderer.js');
