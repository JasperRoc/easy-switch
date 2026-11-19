import { translate } from './i18n.js';

export function taskSyncUI({ call, language }) {
  const $ = id => document.getElementById(id), t = (key, values) => translate(language(), key, values);
  let data, timer, busy = false, signature = '';
  const error = value => { $('sync-error').textContent = value.message || String(value); $('sync-error').hidden = false; };
  function render(next) {
    data = next;
    const state = JSON.stringify([next, language(), $('sync-search').value]); if (state === signature) return; signature = state;
    $('sync-status').textContent = t(next.phase === 'syncing' ? 'syncWorking' : next.configured ? next.enabled ? 'syncReady' : 'syncDisabled' : 'syncSetup');
    if (next.lastSynced && next.phase !== 'syncing') $('sync-status').textContent += ' · ' + new Date(next.lastSynced).toLocaleTimeString(language());
    if (next.error) error(next.error);
    $('sync-now').disabled = !next.configured || busy;
    const list = $('sync-tasks'), fragment = document.createDocumentFragment(), query = $('sync-search').value.toLowerCase();
    for (const task of next.tasks.filter(task => `${task.title} ${task.cwd || ''}`.toLowerCase().includes(query))) {
      const row = document.createElement('div'); row.className = 'sync-task';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!task.enabled;
      check.setAttribute('aria-label', t('syncSelectTask', { title: task.title })); check.disabled = !next.configured;
      check.addEventListener('change', () => action('sync-select', { id: task.id, enabled: check.checked }));
      const info = document.createElement('div'); info.className = 'sync-task-info';
      const title = document.createElement('strong'); title.textContent = task.title;
      const detail = document.createElement('small'); detail.textContent = task.cwd || t('syncOtherComputer'); detail.title = detail.textContent;
      const status = document.createElement('small'); status.className = task.status === 'conflict' || task.status === 'error' ? 'sync-task-error' : '';
      status.textContent = t('syncTask_' + (!task.enabled ? 'off' : task.status || 'pending'));
      if (task.message && task.enabled) status.title = task.message;
      info.append(title, detail, status); row.append(check, info);
      if (task.status === 'needsProject') {
        const folder = document.createElement('button'); folder.className = 'secondary'; folder.textContent = t('syncChooseProject');
        folder.addEventListener('click', () => action('sync-project', task.projectKey)); row.append(folder);
      }
      if (task.status === 'conflict') {
        const choices = document.createElement('div'); choices.className = 'sync-conflict-actions';
        for (const choice of ['local', 'remote']) {
          const button = document.createElement('button'); button.className = 'secondary'; button.textContent = t('syncUse_' + choice);
          button.addEventListener('click', () => { if (confirm(t('syncResolveConfirm'))) action('sync-resolve', { id: task.id, choice }); }); choices.append(button);
        }
        row.append(choices);
      }
      fragment.append(row);
    }
    list.replaceChildren(fragment); $('sync-empty').hidden = !!list.childElementCount;
  }
  async function action(name, payload) {
    if (busy) return;
    busy = true; $('sync-error').hidden = true; $('sync-save').disabled = true; $('sync-refresh').disabled = true; $('sync-now').disabled = true;
    try { render(await call(name, payload)); }
    catch (failure) { error(failure); }
    finally { busy = false; $('sync-save').disabled = false; $('sync-refresh').disabled = false; $('sync-now').disabled = !data?.configured; }
  }
  async function poll() {
    clearTimeout(timer);
    if (!$('sync-dialog').open || document.hidden) return;
    if (!busy) try { render(await call('sync-state')); } catch (failure) { error(failure); }
    timer = setTimeout(poll, 5000);
  }
  $('open-task-sync').addEventListener('click', async () => {
    $('sync-dialog').showModal(); $('sync-error').hidden = true;
    try {
      const next = await call('sync-state');
      $('sync-kind').value = next.kind; $('sync-url').value = next.url; $('sync-username').value = next.username;
      backend();
      $('sync-secret').value = ''; $('sync-passphrase').value = ''; $('sync-enabled').checked = next.enabled || !next.configured;
      render(next); await action('sync-tasks');
    } catch (failure) { error(failure); }
    poll();
  });
  $('sync-form').addEventListener('submit', async event => {
    event.preventDefault();
    await action('sync-configure', { kind: $('sync-kind').value, url: $('sync-url').value, username: $('sync-username').value,
      secret: $('sync-secret').value, passphrase: $('sync-passphrase').value, enabled: $('sync-enabled').checked });
    if (!$('sync-error').hidden) return;
    $('sync-secret').value = ''; $('sync-passphrase').value = '';
    await action('sync-now');
  });
  $('sync-refresh').addEventListener('click', () => action('sync-tasks'));
  function backend() { $('sync-user-field').hidden = $('sync-kind').value === 'server'; }
  $('sync-kind').addEventListener('change', backend);
  $('sync-now').addEventListener('click', () => action('sync-now'));
  $('sync-search').addEventListener('input', () => { if (data) render(data); });
  $('close-sync').addEventListener('click', () => $('sync-dialog').close());
  $('sync-dialog').addEventListener('close', () => clearTimeout(timer));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('sync-dialog').open) poll(); else clearTimeout(timer); });
  return { render: () => { if (data && $('sync-dialog').open) render(data); } };
}
