import { element as $ } from './dom.js';
import { translate, localizeMessage, type TranslationValues } from './i18n.js';

import type { DesktopBridge, DesktopPayload, DesktopResult } from './ipc.js';
import type { Client } from '../src/store.js';

export function extensionsUI({ call, language, currentClient, icon }: {
  call: DesktopBridge['call']; language: () => 'en' | 'zh-CN'; currentClient: () => Client; icon: (name: string) => SVGElement;
}) {
  const t = (key: string, values?: TranslationValues) => translate(language(), key, values);
  interface McpForm {
    type?: string; url?: string; command?: string; args?: string[]; cwd?: string; env_vars?: string[];
    env?: Record<string, string>; headers?: Record<string, string>; http_headers?: Record<string, string>;
    env_http_headers?: Record<string, string>; bearer_token_env_var?: string;
  }
  const clients = { codex: 'Codex', claude: 'Claude Code' };
  const page = $('extensions-page'), dialog = $<HTMLDialogElement>('extension-dialog');
  type ExtensionRow = Partial<DesktopResult<'skill-settings'>[number] & DesktopResult<'mcp-settings'>[number]>
    & Pick<DesktopResult<'skill-settings'>[number], 'name' | 'enabled'>;
  let kind: 'skill' | 'mcp' | '' = '', rows: ExtensionRow[] = [];
  let busy = false, editor = null, candidates = [], signature = '';
  let pasteMcp = false, downloading = false, mcpLoaded = true, mcpDraft = null;
  let linkSkill = '', updating = false;
  let updateResult: Pick<DesktopResult<'skill-update-all'>, 'updated' | 'failures'> | null;
  const open = () => !page.hidden;
  const showError = (error, id) => {
    const element = $(id);
    element.textContent = localizeMessage(String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''), language());
    element.hidden = false;
  };
  function iconButton(symbol, label, handler) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'icon-button'; button.title = label;
    button.setAttribute('aria-label', label); button.append(icon(symbol)); button.addEventListener('click', handler);
    return button;
  }
  function render() {
    if (!open()) return;
    const skill = kind === 'skill';
    if (dialog.open) { dialogTitle(); if (!skill) renderMcpMode(); }
    const query = $<HTMLInputElement>('extensions-search').value.trim().toLowerCase();
    const next = JSON.stringify([kind, rows, query, language(), busy, currentClient(), updating, updateResult]);
    if (next === signature) return;
    signature = next;
    $('extensions-title').textContent = skill ? 'Skills' : 'MCP';
    page.dataset.kind = kind;
    $('extensions-add').lastElementChild.textContent = t(skill ? 'skillAdd' : 'mcpAdd');
    $<HTMLButtonElement>('extensions-add').disabled = busy; $<HTMLButtonElement>('extensions-refresh').disabled = busy;
    $('extensions-refresh').title = t('extensionsRefresh');
    const update = $<HTMLButtonElement>('skills-update'), status = $('skills-update-result');
    const hasSource = rows.some(row => row.updatable);
    update.hidden = !skill;
    update.disabled = busy || !hasSource;
    update.title = t(hasSource ? 'skillUpdateAll' : 'skillNeedsSource');
    update.lastElementChild.textContent = t(updating ? 'skillUpdating' : 'skillUpdateAll');
    status.hidden = !skill || !updateResult;
    if (!status.hidden) {
      const { updated, failures } = updateResult;
      const key = failures.length ? 'skillUpdatePartial' : updated ? 'skillUpdated' : 'skillUpToDate';
      status.classList.toggle('error', !!failures.length);
      status.classList.toggle('notice', !!failures.length);
      status.textContent = [t(key, { count: updated, failed: failures.length }),
        ...failures.map(({ name, message }) => name + ' — ' + localizeMessage(message, language()))].join('\n');
    }
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const detail = skill ? row.description : row.types.map(type => type === 'stdio' ? 'stdio' : type.toUpperCase()).join(' / ');
      if (!`${row.name} ${row.title || ''} ${detail}`.toLowerCase().includes(query)) continue;
      const element = document.createElement('div'); element.className = 'extension-row';
      element.dataset.name = row.name;
      const label = document.createElement('div'); label.className = 'extension-name';
      const name = document.createElement('strong'); name.textContent = row.title || row.name; name.title = name.textContent;
      label.append(name);
      if (detail) {
        const description = document.createElement('small'); description.textContent = detail; description.title = detail;
        label.append(description);
      }
      element.append(label);
      for (const [client, clientLabel] of Object.entries(clients) as [Client, string][]) {
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'route-switch'; toggle.dataset.extensionClient = client;
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(!!row.enabled[client]));
        const accessible = t('extensionToggle', { name: row.title || row.name, client: clientLabel });
        toggle.setAttribute('aria-label', accessible); toggle.title = accessible; toggle.disabled = busy;
        const thumb = document.createElement('span'); thumb.className = 'route-switch-thumb'; thumb.setAttribute('aria-hidden', 'true');
        toggle.append(thumb);
        toggle.addEventListener('click', async () => {
          const focused = document.activeElement === toggle;
          await change({ operation: 'toggle', name: row.name, client, enable: !row.enabled[client] });
          if (focused && document.activeElement === document.body)
            $('extensions-list').querySelector<HTMLElement>(`[data-name="${CSS.escape(row.name)}"] [data-extension-client="${client}"]`)?.focus();
        });
        element.append(toggle);
      }
      const actions = document.createElement('div'); actions.className = 'extension-row-actions';
      if (skill && row.managed) {
        if (!row.updatable) actions.append(iconButton('globe', t('skillLinkSource', { name: name.textContent }), () => openSkill(row.name)));
        actions.append(iconButton('trash', t('extensionsRemove'), () => {
          if (confirm(t('extensionRemoveConfirm', { name: row.title || row.name }))) change({ operation: 'remove', name: row.name, client: 'codex' });
        }));
      } else if (!skill) {
        const supported = (Object.keys(clients) as Client[]).filter(client => row.available[client]);
        actions.append(iconButton('edit', t('editMcp'), () => edit(row.name, supported.includes(currentClient()) ? currentClient() : supported[0])));
      }
      if (actions.childElementCount) {
        for (const button of actions.children as HTMLCollectionOf<HTMLButtonElement>) button.disabled = busy;
        element.append(actions);
      }
      fragment.append(element);
    }
    $('extensions-list').replaceChildren(fragment);
    $('extensions-empty').hidden = !!$('extensions-list').childElementCount;
    $('extensions-empty').textContent = t(busy && !rows.length ? 'extensionsLoading' : query ? 'extensionsNoMatches' : skill ? 'skillEmpty' : 'mcpEmpty');
  }
  async function request<T>(operation: () => Promise<T>, target: string): Promise<T | undefined> {
    if (busy) return;
    busy = true; $(target).hidden = true; dialog.setAttribute('aria-busy', 'true');
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input, select, button, textarea')) control.disabled = true;
    if (downloading) for (const control of dialog.querySelectorAll<HTMLButtonElement>('[data-close-extension],#close-extension-dialog')) control.disabled = false;
    const activeKind = kind;
    render();
    try {
      const result = await operation();
      return activeKind === kind ? result : undefined;
    } catch (error) { if (activeKind === kind && (target === 'extensions-error' || dialog.open)) showError(error, target); }
    finally {
      busy = false; dialog.removeAttribute('aria-busy');
      for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input, select, button, textarea')) control.disabled = false;
      $<HTMLButtonElement>('skill-install').disabled = !candidates.length;
      $<HTMLInputElement>('skill-repo').disabled = $('skill-github').hidden;
      $<HTMLButtonElement>('mcp-save').disabled = $<HTMLButtonElement>('mcp-remove').disabled = !mcpLoaded;
      render();
    }
  }
  async function refresh() {
    updateResult = null;
    const result = await request(() => call(kind === 'skill' ? 'skill-settings' : 'mcp-settings'), 'extensions-error');
    if (result) { rows = result; render(); }
  }
  $('skills-update').addEventListener('click', async () => {
    updating = true; updateResult = null;
    const result = await request(() => call('skill-update-all'), 'extensions-error');
    updating = false;
    if (result) {
      const { rows: updatedRows, updated, failures } = result;
      rows = updatedRows; updateResult = { updated, failures };
    }
    render();
  });
  async function change(payload: DesktopPayload<'mcp-change'>) {
    const result = await request<ExtensionRow[]>(() => kind === 'skill' ? call('skill-change', payload as DesktopPayload<'skill-change'>) : call('mcp-change', payload), dialog.open ? 'mcp-dialog-error' : 'extensions-error');
    if (result) { rows = result; render(); if (dialog.open) closeDialog(); }
  }
  function dialogTitle() {
    const title = kind === 'skill' ? linkSkill ? 'skillLinkSource' : 'skillAdd' : editor ? 'editMcp' : 'mcpAdd';
    $('extension-dialog-title').textContent = t(title, { name: rows.find(row => row.name === linkSkill)?.title });
    $('skill-install').textContent = t(linkSkill ? 'skillSaveSource' : 'skillInstall');
    $('mcp-save').textContent = t(editor ? 'saveChanges' : 'extensionAdd');
  }
  function openDialog() {
    for (const id of ['skill-dialog-error', 'mcp-dialog-error']) $(id).hidden = true;
    dialog.dataset.editor = kind;
    $('mcp-form').hidden = kind !== 'mcp'; $('skill-form').hidden = kind !== 'skill';
    $<HTMLInputElement>('mcp-name').readOnly = !!editor;
    $('mcp-remove').hidden = !editor;
    dialogTitle(); if (kind === 'mcp') renderMcpMode();
    dialog.showModal(); $('extension-dialog-title').focus();
  }
  function mcpFields(config) {
    $<HTMLSelectElement>('mcp-transport').value = config.command ? 'stdio' : config.type === 'sse' ? 'sse' : 'http';
    $<HTMLInputElement>('mcp-url').value = config.url || '';
    $<HTMLInputElement>('mcp-command').value = config.command || '';
    $<HTMLTextAreaElement>('mcp-args').value = Array.isArray(config.args) ? config.args.join('\n') : '';
    const variables = config.env || config.http_headers || config.headers;
    $<HTMLTextAreaElement>('mcp-vars').value = variables && Object.keys(variables).length ? JSON.stringify(variables, null, 2) : '';
    $<HTMLDetailsElement>('mcp-options').open = !!$<HTMLTextAreaElement>('mcp-vars').value;
  }
  function mcpValue(client, base: McpForm = {}) {
    const variables = JSON.parse($<HTMLTextAreaElement>('mcp-vars').value.trim() || '{}');
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error(t('mcpInvalidJSON'));
    const type = $<HTMLSelectElement>('mcp-transport').value;
    const config = { ...base, type };
    if (type === 'stdio') {
      delete config.url; delete config.headers; delete config.http_headers; delete config.env_http_headers; delete config.bearer_token_env_var;
      config.command = $<HTMLInputElement>('mcp-command').value.trim();
      const args = $<HTMLTextAreaElement>('mcp-args').value;
      config.args = args === base.args?.join('\n').replace(/\r\n?/g, '\n') ? base.args : args ? args.split('\n') : [];
      config.env = variables;
      if (!config.args.length && !Object.hasOwn(base, 'args')) delete config.args;
      if (!Object.keys(variables).length && !Object.hasOwn(base, 'env')) delete config.env;
    } else {
      delete config.command; delete config.args; delete config.env; delete config.cwd; delete config.env_vars;
      config.url = $<HTMLInputElement>('mcp-url').value.trim();
      const headers = client === 'claude' ? 'headers' : 'http_headers';
      if (Object.keys(variables).length || Object.hasOwn(base, headers)) config[headers] = variables;
    }
    return config;
  }
  async function loadMcp(client: Client) {
    const current = editor;
    if (!current) return;
    mcpLoaded = false;
    $<HTMLTextAreaElement>('mcp-config').value = '';
    $<HTMLButtonElement>('mcp-save').disabled = $<HTMLButtonElement>('mcp-remove').disabled = true;
    $('mcp-dialog-error').hidden = true;
    renderMcpMode();
    try {
      const details = await call('mcp-details', { name: current.name, client });
      if (editor !== current || $<HTMLSelectElement>('mcp-client').value !== client) return;
      editor = { name: current.name, client, expected: details.config }; mcpDraft = null;
      pasteMcp = !details.config.command && !details.config.url || (details.config.type && !['http', 'stdio', 'sse', 'streamable-http'].includes(details.config.type));
      $<HTMLTextAreaElement>('mcp-config').value = JSON.stringify(details.config, null, 2);
      mcpFields(details.config); mcpLoaded = true;
      $<HTMLButtonElement>('mcp-save').disabled = $<HTMLButtonElement>('mcp-remove').disabled = false; renderMcpMode();
    } catch (error) { if (editor === current && $<HTMLSelectElement>('mcp-client').value === client) showError(error, 'mcp-dialog-error'); }
  }
  function clientOptions(select, allowed, selected) {
    for (const option of select.options) option.disabled = !allowed.includes(option.value);
    select.value = selected;
  }
  async function edit(name: string, client: Client) {
    editor = { name, client };
    mcpLoaded = false; pasteMcp = false;
    $<HTMLFormElement>('mcp-form').reset();
    $<HTMLInputElement>('mcp-name').value = name; $<HTMLTextAreaElement>('mcp-config').value = '';
    clientOptions($('mcp-client'), Object.keys(clients).filter(key => rows.find(row => row.name === name)?.available[key]), client);
    openDialog(); await loadMcp(client);
  }
  $('mcp-client').addEventListener('change', () => {
    if (editor) loadMcp($<HTMLSelectElement>('mcp-client').value as Client);
    else renderMcpMode();
  });
  function renderMcpMode() {
    const claude = $<HTMLSelectElement>('mcp-client').value === 'claude';
    const transport = $<HTMLSelectElement>('mcp-transport');
    transport.querySelector<HTMLOptionElement>('[value="sse"]').disabled = !claude;
    if (!claude && transport.value === 'sse') transport.value = 'http';
    const stdio = transport.value === 'stdio';
    $('mcp-fields').hidden = pasteMcp; $('mcp-source').hidden = !pasteMcp;
    $<HTMLTextAreaElement>('mcp-config').required = pasteMcp;
    $('mcp-endpoint-field').hidden = $<HTMLInputElement>('mcp-url').disabled = stdio || pasteMcp;
    $<HTMLInputElement>('mcp-url').required = !stdio && !pasteMcp;
    $('mcp-command-field').hidden = $('mcp-args-field').hidden = !stdio || pasteMcp;
    $<HTMLInputElement>('mcp-command').required = stdio && !pasteMcp;
    $<HTMLButtonElement>('mcp-entry-mode').disabled = busy || !mcpLoaded;
    $('mcp-entry-mode').textContent = t(pasteMcp ? 'mcpFormMode' : 'mcpPasteMode');
    $('mcp-vars-title').textContent = t(stdio ? 'mcpEnv' : 'mcpHeaders');
    $<HTMLTextAreaElement>('mcp-config').placeholder = JSON.stringify({ ...(claude && { type: 'http' }), url: 'https://example.com/mcp' }, null, 2);
  }
  $('mcp-entry-mode').addEventListener('click', async () => {
    const client = $<HTMLSelectElement>('mcp-client').value as Client;
    $('mcp-dialog-error').hidden = true;
    if (pasteMcp) {
      if ($<HTMLTextAreaElement>('mcp-config').value.trim()) {
        const parsed = await request(() => call('mcp-parse', { client, name: $<HTMLInputElement>('mcp-name').value.trim(), text: $<HTMLTextAreaElement>('mcp-config').value }), 'mcp-dialog-error');
        if (!parsed) return;
        $<HTMLInputElement>('mcp-name').value = parsed.name; mcpFields(parsed.config);
        mcpDraft = parsed.config;
      }
    } else {
      const base = mcpDraft || editor?.expected;
      try { $<HTMLTextAreaElement>('mcp-config').value = !base && !($<HTMLInputElement>('mcp-url').value || $<HTMLInputElement>('mcp-command').value) ? '' : JSON.stringify(mcpValue(client, base), null, 2); }
      catch (error) { showError(new Error(t('mcpInvalidJSON')), 'mcp-dialog-error'); return; }
    }
    pasteMcp = !pasteMcp; renderMcpMode();
  });
  $('mcp-transport').addEventListener('change', () => { $<HTMLTextAreaElement>('mcp-vars').value = ''; renderMcpMode(); });
  $('extensions-add').addEventListener('click', () => {
    if (kind === 'skill') return openSkill();
    editor = null; mcpDraft = null; mcpLoaded = true; $<HTMLButtonElement>('mcp-save').disabled = false;
    pasteMcp = false; $<HTMLFormElement>('mcp-form').reset(); $<HTMLDetailsElement>('mcp-options').open = false;
    clientOptions($('mcp-client'), Object.keys(clients), currentClient());
    openDialog();
  });
  $('mcp-form').addEventListener('submit', event => {
    event.preventDefault();
    const client = $<HTMLSelectElement>('mcp-client').value as Client;
    if (editor && (editor.client !== client || !editor.expected)) return;
    let text = $<HTMLTextAreaElement>('mcp-config').value;
    if (!pasteMcp) {
      try { text = JSON.stringify(mcpValue(client, mcpDraft || editor?.expected)); }
      catch { showError(new Error(t('mcpInvalidJSON')), 'mcp-dialog-error'); return; }
    }
    change({ operation: editor ? 'edit' : 'add', name: $<HTMLInputElement>('mcp-name').value.trim(), client, text, expected: editor?.expected });
  });
  $('mcp-remove').addEventListener('click', () => {
    if (editor?.expected && editor.client === $<HTMLSelectElement>('mcp-client').value &&
        confirm(t('extensionRemoveConfirm', { name: editor.name + ' · ' + clients[editor.client] })))
      change({ operation: 'remove', name: editor.name, client: editor.client, expected: editor.expected });
  });
  function skillDescription() {
    const text = candidates[$<HTMLSelectElement>('skill-choice').selectedIndex]?.description || '';
    $('skill-description').textContent = text; $('skill-preview').hidden = !text; $<HTMLDetailsElement>('skill-preview').open = false;
  }
  function setSkillMode(mode) {
    for (const button of document.querySelectorAll<HTMLElement>('[data-skill-mode]')) button.setAttribute('aria-pressed', String(button.dataset.skillMode === mode));
    $('skill-github').hidden = mode !== 'github'; $('skill-local').hidden = mode !== 'local';
    $<HTMLInputElement>('skill-repo').disabled = mode !== 'github';
    $('skill-results').hidden = $<HTMLButtonElement>('skill-install').disabled = $('skill-dialog-error').hidden = true;
    candidates = [];
  }
  function openSkill(name = '') {
    linkSkill = name;
    $('skill-source-modes').hidden = $('skill-client-field').hidden = !!name;
    $<HTMLInputElement>('skill-repo').value = ''; setSkillMode('github');
    $<HTMLSelectElement>('skill-client').value = currentClient();
    openDialog();
  }
  async function discover(kind: 'folder' | 'zip' | 'github', source?: string) {
    downloading = kind === 'github'; $('skill-loading').hidden = !downloading;
    const result = await request(() => call('skill-discover', { kind, source }), 'skill-dialog-error');
    downloading = false; $('skill-loading').hidden = true;
    if (!dialog.open) { call('skill-discard').catch(() => {}); return; }
    if (!result) { $('skill-results').hidden = $<HTMLButtonElement>('skill-install').disabled = true; candidates = []; return; }
    candidates = linkSkill ? result.candidates.filter(item => item.name === linkSkill) : result.candidates;
    if (!candidates.length) {
      $('skill-results').hidden = $<HTMLButtonElement>('skill-install').disabled = true;
      showError(new Error('The repository does not contain this installed Skill.'), 'skill-dialog-error');
      return;
    }
    const names = new Map();
    for (const item of candidates) names.set(item.title, (names.get(item.title) || 0) + 1);
    $('skill-choice').replaceChildren(...candidates.map(item => new Option(item.title + (names.get(item.title) > 1 ? ` · ${item.id}` : ''), item.id)));
    $('skill-results').hidden = $<HTMLButtonElement>('skill-install').disabled = false; skillDescription();
  }
  $('skill-form').addEventListener('submit', event => { event.preventDefault(); if (!$('skill-github').hidden) discover('github', $<HTMLInputElement>('skill-repo').value.trim()); });
  $('skill-repo').addEventListener('input', () => setSkillMode('github'));
  for (const button of document.querySelectorAll<HTMLElement>('[data-skill-mode]')) button.addEventListener('click', () => setSkillMode(button.dataset.skillMode));
  for (const button of document.querySelectorAll<HTMLElement>('[data-skill-source]')) button.addEventListener('click', () => discover(button.dataset.skillSource as 'folder' | 'zip'));
  $('skill-choice').addEventListener('change', skillDescription);
  $('skill-install').addEventListener('click', async () => {
    const payload = { id: $<HTMLSelectElement>('skill-choice').value, client: $<HTMLSelectElement>('skill-client').value as Client, ...(linkSkill && { link: linkSkill }) };
    const result = await request(() => call('skill-import', payload), 'skill-dialog-error');
    if (result) { rows = result; if (linkSkill) updateResult = null; render(); closeDialog(); }
  });
  function closeDialog() {
    dialog.close();
    if (downloading) call('skill-cancel').catch(() => {});
    $<HTMLFormElement>('mcp-form').reset(); editor = mcpDraft = null;
    $<HTMLInputElement>('skill-repo').value = ''; candidates = []; linkSkill = '';
    if (!$('skill-form').hidden) call('skill-discard').catch(() => {});
  }
  $('close-extension-dialog').addEventListener('click', closeDialog);
  for (const button of document.querySelectorAll<HTMLElement>('[data-close-extension]')) button.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy || downloading) closeDialog(); });
  $('extensions-search').addEventListener('input', render);
  $('extensions-refresh').addEventListener('click', refresh);
  function close() {
    if (!open()) return;
    if (dialog.open) closeDialog();
    page.hidden = true; $('settings-overview').hidden = false; $('settings-page').scrollTop = 0; kind = '';
  }
  $('close-extensions').addEventListener('click', close);
  for (const button of document.querySelectorAll<HTMLElement>('[data-extensions]')) button.addEventListener('click', async () => {
    if (busy) return;
    kind = button.dataset.extensions as 'skill' | 'mcp'; rows = []; signature = '';
    $<HTMLInputElement>('extensions-search').value = ''; $('extensions-error').hidden = true;
    $('settings-overview').hidden = true; page.hidden = false; $('settings-page').scrollTop = 0;
    await refresh();
  });
  return { close, render };
}
