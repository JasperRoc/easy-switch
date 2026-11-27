import { element as $ } from './dom.js';
import { translate, localizeMessage, type TranslationValues } from './i18n.js';
import type { DesktopArgs, DesktopBridge, DesktopResult } from './ipc.js';
import type { SyncConnection } from '../src/task-sync.js';
import { syncURL, webdavLibraryURL } from '../src/sync-url.js';

type SyncAction = 'sync-client' | 'sync-select' | 'sync-resolve' | 'sync-remove-remote' | 'sync-configure' | 'sync-tasks' | 'sync-now';

export function taskSyncUI({ call, language }: { call: DesktopBridge['call']; language: () => 'en' | 'zh-CN' }) {
  const t = (key: string, values?: TranslationValues) => translate(language(), key, values);
  const visible = () => !$('sync-page').hidden && !$('settings-page').hidden;
  let data: DesktopResult<'sync-state'>, timer: ReturnType<typeof setTimeout>;
  let busy = false, signature = '', actionError = '';
  let savedURL = '';
  const clientButton = $<HTMLButtonElement>('sync-client'), clientMenu = $('sync-client-menu');
  const clientOptions = [...clientMenu.querySelectorAll<HTMLButtonElement>('[data-sync-client]')];
  function closeClientMenu(restoreFocus = false) {
    clientMenu.hidden = true; clientButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) clientButton.focus();
  }
  function openClientMenu() {
    if (clientButton.disabled) return;
    clientMenu.hidden = false; clientButton.setAttribute('aria-expanded', 'true');
    clientOptions.find(option => option.dataset.syncClient === clientButton.value)?.focus();
  }
  const error = value => { $('sync-error').textContent = localizeMessage(String(value.message || value).replace(/^Error invoking remote method '[^']+': Error: /, ''), language()); $('sync-error').hidden = false; };
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', 'assets/ui.svg#' + name); svg.append(use); return svg;
  };
  function tab(name) {
    closeClientMenu();
    for (const value of ['tasks', 'storage']) {
      const selected = value === name, button = $('sync-' + value + '-tab');
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    $('sync-library').hidden = name !== 'tasks'; $('sync-connection').hidden = name !== 'storage';
    $('settings-page').scrollTop = 0;
  }
  function backend() {
    const ssh = $<HTMLInputElement>('sync-kind').value === 'ssh';
    $('sync-ssh-field').hidden = !ssh; $<HTMLInputElement>('sync-ssh').required = ssh;
    $('sync-user-field').hidden = $('sync-url-field').hidden = $('sync-secret-field').hidden = ssh;
    $<HTMLInputElement>('sync-url').required = !ssh; $<HTMLInputElement>('sync-url').disabled = busy || ssh;
    $<HTMLInputElement>('sync-passphrase').required = !data?.hasPassphrase;
    for (const button of document.querySelectorAll<HTMLElement>('[data-sync-kind]')) button.setAttribute('aria-pressed', String(button.dataset.syncKind === $<HTMLInputElement>('sync-kind').value));
  }
  function webdavAddress(normalize = false) {
    const input = $<HTMLInputElement>('sync-url'), suffix = $('sync-url-suffix');
    suffix.textContent = '/fluid/';
    let append = true;
    if (input.value) try {
      const value = syncURL(input.value);
      const saved = data?.kind === 'webdav' ? data.url : undefined;
      const library = webdavLibraryURL(value, saved);
      append = library !== value;
      if (normalize && library.endsWith(suffix.textContent)) {
        const base = library.slice(0, -suffix.textContent.length);
        if (webdavLibraryURL(base, saved) === library) {
          input.value = base;
          append = true;
        }
      }
    } catch { /* The save action reports invalid URLs. */ }
    suffix.hidden = !append;
    if (append) input.setAttribute('aria-describedby', suffix.id);
    else input.removeAttribute('aria-describedby');
  }
  function render(next: DesktopResult<'sync-state'>) {
    data = next; savedURL = next.kind === 'webdav' ? next.url : ''; clientButton.value = next.client;
    $('sync-client-label').textContent = next.client === 'claude' ? 'Claude Code' : 'Codex';
    for (const option of clientOptions) option.setAttribute('aria-checked', String(option.dataset.syncClient === next.client));
    backend();
    for (const [id, key] of [['sync-refresh', 'syncRefresh'], ['sync-now', 'syncNow']]) $(id).title = t(key);
    const state = JSON.stringify([next, language(), $<HTMLInputElement>('sync-search').value]); if (state === signature) return; signature = state;
    const storage = next.kind === 'ssh' ? t('syncSSH') : 'WebDAV';
    const status = next.legacyStorage ? 'syncLegacyStorage' : !next.configured ? 'syncSetup' :
      next.phase === 'syncing' ? 'syncWorking' : next.phase === 'error' ? 'syncFailed' : next.enabled ? 'syncReady' : 'syncDisabled';
    $('sync-status').textContent = t(status, { storage, address: next.url });
    if (next.lastSynced && next.phase !== 'syncing') $('sync-status').textContent += ' · ' + new Date(next.lastSynced).toLocaleTimeString(language());
    $('sync-status').parentElement.dataset.phase = next.phase;
    if (actionError || next.error) error(actionError || next.error); else $('sync-error').hidden = true;
    $<HTMLButtonElement>('sync-now').disabled = !next.enabled || busy;
    const list = $('sync-tasks'), fragment = document.createDocumentFragment(), query = $<HTMLInputElement>('sync-search').value.toLowerCase();
    for (const task of next.tasks.filter(task => `${task.title} ${task.cwd || ''}`.toLowerCase().includes(query))) {
      const row = document.createElement('div'); row.className = 'sync-task';
      const check = document.createElement('button'); check.type = 'button'; check.className = 'sync-task-toggle'; check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(!!task.enabled)); check.append(icon('check'));
      check.setAttribute('aria-label', t(task.enabled ? 'syncPauseTask' : 'syncSelectTask', { title: task.title })); check.disabled = !next.configured || busy;
      check.addEventListener('click', () => action('sync-select', { id: task.id, enabled: !task.enabled }));
      const info = document.createElement('div'); info.className = 'sync-task-info';
      const title = document.createElement('strong'); title.textContent = task.title;
      const detail = document.createElement('small'); detail.textContent = task.cwd || t('syncOtherComputer'); detail.title = detail.textContent;
      const status = document.createElement('span'), phase = task.status || (task.enabled ? 'pending' : 'off'); status.className = 'sync-task-status'; status.dataset.status = phase;
      status.textContent = t('syncTask_' + phase);
      const statuses = document.createElement('div'); statuses.className = 'sync-task-labels';
      if (task.archived) {
        const archived = document.createElement('span'); archived.className = 'sync-task-archived'; archived.textContent = t('syncArchived');
        statuses.append(archived);
      }
      statuses.append(status); info.append(title, detail); row.append(check, info, statuses);
      if (task.message && task.enabled) {
        const message = document.createElement('small'); message.className = 'sync-task-message';
        message.textContent = localizeMessage(task.message, language()); status.title = message.textContent; info.append(message);
      }
      if (task.enabled && task.status === 'conflict') {
        const choices = document.createElement('div'); choices.className = 'sync-task-actions';
        for (const choice of ['local', 'remote']) {
          const button = document.createElement('button'); button.className = 'secondary'; button.disabled = busy;
          button.textContent = t('syncUse_' + choice);
          button.addEventListener('click', () => {
            if (confirm(t('syncResolveConfirm'))) action('sync-resolve', { id: task.id, choice });
          }); choices.append(button);
        }
        info.append(statuses);
        row.append(choices);
      }
      if (task.remote || task.cleanupPending) {
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'icon-button sync-remove'; remove.append(icon('trash'));
        remove.title = t('syncRemoveRemote'); remove.setAttribute('aria-label', t('syncRemoveRemoteTask', { title: task.title }));
        remove.disabled = !next.configured || busy;
        remove.addEventListener('click', () => {
          const { kind, url, username } = next;
          if (confirm(t('syncRemoveRemoteConfirm', { title: task.title, storage, address: url })))
            action('sync-remove-remote', { id: task.id, storage: { kind, url, username } });
        });
        row.append(remove);
      }
      fragment.append(row);
    }
    list.replaceChildren(fragment); $('sync-empty').hidden = !!list.childElementCount;
    $('sync-empty-text').textContent = t(query ? 'syncNoMatches' : 'syncEmpty');
  }
  async function action<A extends SyncAction>(name: A, ...args: DesktopArgs<A>) {
    if (busy) return false;
    closeClientMenu(); busy = true; actionError = ''; $('sync-error').hidden = true; signature = '';
    const fields = $('sync-form').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button');
    for (const control of [...fields, clientButton, $<HTMLButtonElement>('sync-refresh'), $<HTMLButtonElement>('sync-now')]) control.disabled = true;
    $('sync-save').textContent = t(name === 'sync-configure' ? 'syncVerifying' : 'syncVerify');
    try { const next = await call(name, ...args); render(next); return !next.error; }
    catch (failure) {
      actionError = String(failure.message || failure).replace(/^Error invoking remote method '[^']+': Error: /, '');
      if (name === 'sync-remove-remote') {
        try {
          const next = await call('sync-state');
          if (next.error === actionError) actionError = '';
          render(next);
        } catch { /* Keep the original failure. */ }
      }
      if (actionError) error(actionError);
      return false;
    }
    finally {
      busy = false;
      for (const control of [...fields, clientButton, $<HTMLButtonElement>('sync-refresh')]) control.disabled = false;
      $('sync-save').textContent = t('syncVerify'); backend();
      $<HTMLButtonElement>('sync-now').disabled = !data?.enabled;
      for (const button of $('sync-tasks').querySelectorAll('button')) button.disabled = !data?.configured;
    }
  }
  async function poll() {
    clearTimeout(timer);
    if (!visible() || document.hidden) return;
    if (!busy) try { render(await call('sync-state')); } catch (failure) { error(failure); }
    timer = setTimeout(poll, 5000);
  }
  function close() {
    closeClientMenu();
    if (!$('sync-page').hidden) $<HTMLInputElement>('sync-secret').value = $<HTMLInputElement>('sync-passphrase').value = '';
    $('sync-page').hidden = true; $('settings-overview').hidden = false; $('settings-page').scrollTop = 0; clearTimeout(timer);
  }
  $('open-task-sync').addEventListener('click', async () => {
    $('settings-overview').hidden = true; $('sync-page').hidden = false; $('sync-error').hidden = true; actionError = ''; signature = '';
    try {
      const next = await call('sync-state');
      $<HTMLInputElement>('sync-kind').value = next.kind; $<HTMLInputElement>('sync-ssh').value = next.kind === 'ssh' ? next.url : '';
      $<HTMLInputElement>('sync-url').value = next.kind === 'ssh' ? '' : next.url; $<HTMLInputElement>('sync-username').value = next.username;
      $<HTMLInputElement>('sync-secret').value = ''; $<HTMLInputElement>('sync-passphrase').value = ''; $('sync-enabled').setAttribute('aria-checked', String(next.enabled || !next.configured));
      tab(next.configured ? 'tasks' : 'storage'); render(next); webdavAddress(true); await action('sync-tasks');
    } catch (failure) { error(failure); }
    poll();
  });
  $('sync-form').addEventListener('submit', async event => {
    event.preventDefault();
    const kind = $<HTMLInputElement>('sync-kind').value as SyncConnection['kind'];
    const connection = kind === 'ssh' ? { url: $<HTMLInputElement>('sync-ssh').value } :
      { url: $<HTMLInputElement>('sync-url').value, username: $<HTMLInputElement>('sync-username').value, secret: $<HTMLInputElement>('sync-secret').value };
    const saved = await action('sync-configure', { kind, ...connection,
      passphrase: $<HTMLInputElement>('sync-passphrase').value, enabled: $('sync-enabled').getAttribute('aria-checked') === 'true' });
    if (!saved) return;
    $<HTMLInputElement>(kind === 'ssh' ? 'sync-ssh' : 'sync-url').value = data.url;
    $<HTMLInputElement>('sync-secret').value = ''; $<HTMLInputElement>('sync-passphrase').value = '';
    webdavAddress(true); backend(); tab('tasks'); await action('sync-now');
  });
  $('sync-url').addEventListener('input', () => webdavAddress());
  $('sync-url').addEventListener('blur', () => webdavAddress(true));
  for (const button of document.querySelectorAll<HTMLElement>('[data-sync-kind]')) button.addEventListener('click', () => { $<HTMLInputElement>('sync-kind').value = button.dataset.syncKind; backend(); });
  for (const name of ['tasks', 'storage']) $('sync-' + name + '-tab').addEventListener('click', () => tab(name));
  $('sync-page').addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (!target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const name = event.key === 'Home' ? 'tasks' : event.key === 'End' ? 'storage' : target.id === 'sync-tasks-tab' ? 'storage' : 'tasks';
    tab(name); $('sync-' + name + '-tab').focus();
  });
  $('sync-enabled').addEventListener('click', () => $('sync-enabled').setAttribute('aria-checked', String($('sync-enabled').getAttribute('aria-checked') !== 'true')));
  $('sync-guide').addEventListener('click', () => call('sync-guide', language()).catch(error));
  clientButton.addEventListener('click', () => { if (clientMenu.hidden) openClientMenu(); else closeClientMenu(); });
  clientButton.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); openClientMenu();
  });
  clientMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeClientMenu(true); return; }
    if (event.key === 'Tab') { closeClientMenu(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = clientOptions.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? clientOptions.length - 1 :
      (current + (event.key === 'ArrowDown' ? 1 : -1) + clientOptions.length) % clientOptions.length;
    clientOptions[next].focus();
  });
  for (const option of clientOptions) option.addEventListener('click', () => {
    closeClientMenu(true);
    if (option.dataset.syncClient === clientButton.value) return;
    $<HTMLInputElement>('sync-search').value = '';
    action('sync-client', option.dataset.syncClient as 'codex' | 'claude');
  });
  for (const event of ['click', 'focusin']) document.addEventListener(event, event => {
    if (!(event.target as Element).closest('.sync-client-control')) closeClientMenu();
  });
  $('sync-refresh').addEventListener('click', () => action('sync-tasks'));
  $('sync-now').addEventListener('click', () => action('sync-now'));
  $('sync-search').addEventListener('input', () => { if (data) render(data); });
  $('close-sync').addEventListener('click', close);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible()) poll(); else clearTimeout(timer); });
  return { close, render: () => { if (data && visible()) render(data); } };
}
