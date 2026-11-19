import { translate, localizeMessage } from './i18n.js';

export function taskSyncUI({ call, language }) {
  const $ = id => document.getElementById(id), t = (key, values) => translate(language(), key, values);
  const visible = () => !$('sync-page').hidden && !$('settings-page').hidden;
  let data, timer, busy = false, signature = '';
  const error = value => { $('sync-error').textContent = localizeMessage(String(value.message || value).replace(/^Error invoking remote method '[^']+': Error: /, ''), language()); $('sync-error').hidden = false; };
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', 'assets/ui.svg#' + name); svg.append(use); return svg;
  };
  function tab(name) {
    for (const value of ['tasks', 'storage']) {
      const selected = value === name, button = $('sync-' + value + '-tab');
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    $('sync-library').hidden = name !== 'tasks'; $('sync-connection').hidden = name !== 'storage';
    $('settings-page').scrollTop = 0;
  }
  function backend() {
    const server = $('sync-kind').value === 'server';
    $('sync-user-field').hidden = server; $('sync-secret-field').classList.toggle('sync-full', server);
    $('sync-secret-label').textContent = t(server ? 'syncToken' : 'syncWebDAVPassword');
    $('sync-backend-help').textContent = t(server ? 'syncServerHelp' : 'syncWebDAVHelp');
    $('sync-url').placeholder = server ? 'https://sync.example.com/' : 'https://dav.example.com/easy-switch/';
    for (const button of document.querySelectorAll('[data-sync-kind]')) button.setAttribute('aria-pressed', String(button.dataset.syncKind === $('sync-kind').value));
  }
  function render(next) {
    data = next; backend();
    for (const [id, key] of [['sync-refresh', 'syncRefresh'], ['sync-now', 'syncNow']]) $(id).title = t(key);
    const state = JSON.stringify([next, language(), $('sync-search').value]); if (state === signature) return; signature = state;
    $('sync-status').textContent = t(next.phase === 'syncing' ? 'syncWorking' : next.configured ? next.enabled ? 'syncReady' : 'syncDisabled' : 'syncSetup');
    if (next.lastSynced && next.phase !== 'syncing') $('sync-status').textContent += ' · ' + new Date(next.lastSynced).toLocaleTimeString(language());
    $('sync-status').parentElement.dataset.phase = next.phase;
    if (next.error) error(next.error); else $('sync-error').hidden = true;
    $('sync-now').disabled = !next.configured || busy;
    const list = $('sync-tasks'), fragment = document.createDocumentFragment(), query = $('sync-search').value.toLowerCase();
    for (const task of next.tasks.filter(task => `${task.title} ${task.cwd || ''}`.toLowerCase().includes(query))) {
      const row = document.createElement('div'); row.className = 'sync-task';
      const check = document.createElement('button'); check.type = 'button'; check.className = 'sync-task-toggle'; check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(!!task.enabled)); check.append(icon('check'));
      check.setAttribute('aria-label', t('syncSelectTask', { title: task.title })); check.disabled = !next.configured || busy;
      check.addEventListener('click', () => action('sync-select', { id: task.id, enabled: !task.enabled }));
      const info = document.createElement('div'); info.className = 'sync-task-info';
      const title = document.createElement('strong'); title.textContent = task.title;
      const detail = document.createElement('small'); detail.textContent = task.cwd || t('syncOtherComputer'); detail.title = detail.textContent;
      const status = document.createElement('span'), phase = !task.enabled ? 'off' : task.status || 'pending'; status.className = 'sync-task-status'; status.dataset.status = phase;
      status.textContent = t('syncTask_' + phase); if (task.message && task.enabled) status.title = task.message;
      info.append(title, detail); row.append(check, info, status);
      if (task.enabled && ['needsProject', 'conflict'].includes(task.status)) {
        const choices = document.createElement('div'); choices.className = 'sync-task-actions';
        for (const choice of task.status === 'needsProject' ? ['project'] : ['local', 'remote']) {
          const button = document.createElement('button'); button.className = 'secondary'; button.disabled = busy;
          button.textContent = t(choice === 'project' ? 'syncChooseProject' : 'syncUse_' + choice);
          button.addEventListener('click', () => {
            if (choice === 'project') action('sync-project', task.projectKey);
            else if (confirm(t('syncResolveConfirm'))) action('sync-resolve', { id: task.id, choice });
          }); choices.append(button);
        }
        info.append(status);
        row.append(choices);
      }
      fragment.append(row);
    }
    list.replaceChildren(fragment); $('sync-empty').hidden = !!list.childElementCount;
    $('sync-empty-text').textContent = t(query ? 'syncNoMatches' : 'syncEmpty');
  }
  async function action(name, payload) {
    if (busy) return false;
    busy = true; $('sync-error').hidden = true;
    for (const id of ['sync-save', 'sync-refresh', 'sync-now', 'sync-enabled']) $(id).disabled = true;
    try { const next = await call(name, payload); render(next); return !next.error; }
    catch (failure) { error(failure); return false; }
    finally {
      busy = false; for (const id of ['sync-save', 'sync-refresh', 'sync-enabled']) $(id).disabled = false;
      $('sync-now').disabled = !data?.configured;
      for (const button of $('sync-tasks').querySelectorAll('button')) button.disabled = !data?.configured;
    }
  }
  async function poll() {
    clearTimeout(timer);
    if (!visible() || document.hidden) return;
    if (!busy) try { render(await call('sync-state')); } catch (failure) { error(failure); }
    timer = setTimeout(poll, 5000);
  }
  function close() { $('sync-page').hidden = true; $('settings-overview').hidden = false; $('settings-page').scrollTop = 0; clearTimeout(timer); }
  $('open-task-sync').addEventListener('click', async () => {
    $('settings-overview').hidden = true; $('sync-page').hidden = false; $('sync-error').hidden = true;
    try {
      const next = await call('sync-state');
      $('sync-kind').value = next.kind; $('sync-url').value = next.url; $('sync-username').value = next.username;
      $('sync-secret').value = ''; $('sync-passphrase').value = ''; $('sync-enabled').setAttribute('aria-checked', String(next.enabled || !next.configured));
      tab(next.configured ? 'tasks' : 'storage'); render(next); await action('sync-tasks');
    } catch (failure) { error(failure); }
    poll();
  });
  $('sync-form').addEventListener('submit', async event => {
    event.preventDefault();
    const saved = await action('sync-configure', { kind: $('sync-kind').value, url: $('sync-url').value, username: $('sync-username').value,
      secret: $('sync-secret').value, passphrase: $('sync-passphrase').value, enabled: $('sync-enabled').getAttribute('aria-checked') === 'true' });
    if (!saved) return;
    $('sync-secret').value = ''; $('sync-passphrase').value = ''; tab('tasks'); await action('sync-now');
  });
  for (const button of document.querySelectorAll('[data-sync-kind]')) button.addEventListener('click', () => { $('sync-kind').value = button.dataset.syncKind; backend(); });
  for (const name of ['tasks', 'storage']) $('sync-' + name + '-tab').addEventListener('click', () => tab(name));
  $('sync-page').addEventListener('keydown', event => {
    if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const name = event.key === 'Home' ? 'tasks' : event.key === 'End' ? 'storage' : event.target.id === 'sync-tasks-tab' ? 'storage' : 'tasks';
    tab(name); $('sync-' + name + '-tab').focus();
  });
  $('sync-enabled').addEventListener('click', () => $('sync-enabled').setAttribute('aria-checked', String($('sync-enabled').getAttribute('aria-checked') !== 'true')));
  $('sync-guide').addEventListener('click', () => call('sync-guide', language()).catch(error));
  $('sync-refresh').addEventListener('click', () => action('sync-tasks'));
  $('sync-now').addEventListener('click', () => action('sync-now'));
  $('sync-search').addEventListener('input', () => { if (data) render(data); });
  $('close-sync').addEventListener('click', close);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible()) poll(); else clearTimeout(timer); });
  return { close, render: () => { if (data && visible()) render(data); } };
}
