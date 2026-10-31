import { translate, normalizeLanguage, localizeMessage } from './i18n.js';
import { releaseNotes } from './release-notes.js';
const $ = id => document.getElementById(id);
let state, catalog = [], catalogAlias = null, activeTab = 'providers', renderedProviders = '', refreshing = null, modelDirty = false;
let language = 'en', appliedLanguage, catalogNotice = 'loadCatalog', rawNotice = false, providerMode = 'account', dragging = null, renderedUpdate = '';
let networkState = null;
let catalogLoading = false, catalogFailed = false, catalogLoaded = null, effortSignature = '', importLoading = false;
let modelTarget = null, renderedSessions = '', modelFeedback = null;
const t = (key, values) => translate(language, key, values);
function appearance() {
  language = normalizeLanguage(state.language);
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  document.documentElement.dataset.platform = state.platform;
  $('theme-symbol').setAttribute('href', `assets/ui.svg#${state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'monitor'}`);
  for (const item of document.querySelectorAll('[data-language]')) item.setAttribute('aria-checked', String(item.dataset.language === language));
  for (const item of document.querySelectorAll('[data-theme]')) if (item.tagName === 'BUTTON') item.setAttribute('aria-checked', String(item.dataset.theme === state.theme));
  if (appliedLanguage === language) return;
  appliedLanguage = language;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of document.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  $('language-button').title = t('language'); $('theme-button').title = t('appearance');
  renderModelPicker(); renderEfforts(); renderCatalogStatus();
  for (const element of document.querySelectorAll('[data-error]')) element.textContent = localizeMessage(element.dataset.error, language);
  providerType();
}
function notice(value, raw = false) { catalogNotice = value; rawNotice = raw; $('model-notice').textContent = raw ? localizeMessage(value, language) : t(value); }
const call = (action, payload) => window.easySwitch.call(action, payload);
function showError(error, target = 'error') {
  const text = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
  $(target).dataset.error = text; $(target).textContent = localizeMessage(text, language);
  $(target).hidden = false;
}
async function run(action, payload) {
  $('error').hidden = true;
  try { const result = await call(action, payload); if (refreshing) await refreshing; await refresh(); return result; }
  catch (error) { showError(error); throw error; }
}
function node(tag, text, className) {
  const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element;
}
function button(text, handler, className = 'secondary') {
  const element = node('button', text, className); element.addEventListener('click', () => Promise.resolve(handler()).catch(() => {})); return element;
}
function icon(name) { const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'), use=document.createElementNS('http://www.w3.org/2000/svg','use'); use.setAttribute('href',`assets/ui.svg#${name}`); svg.setAttribute('aria-hidden','true'); svg.append(use); return svg; }
function renderProviders() {
  const signature = JSON.stringify([language, state.providers]);
  if (signature === renderedProviders || dragging) return;
  renderedProviders = signature; $('provider-list').replaceChildren(); $('empty').hidden = !!state.providers.length;
  state.providers.forEach((provider, index) => {
    const row = node('div', null, `provider${provider.active ? ' active' : ''}`);
    row.dataset.alias = provider.alias;
    const handle = button('', () => {}, 'drag-handle'); handle.append(icon('grip')); handle.draggable = true; handle.setAttribute('aria-label', t('drag', {alias: provider.alias}));
    handle.addEventListener('dragstart', event => { dragging = provider.alias; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', provider.alias); event.dataTransfer.setDragImage(row, 20, 20); });
    handle.addEventListener('dragend', () => { if (dragging) { dragging = null; renderedProviders = ''; renderProviders(); } });
    handle.addEventListener('keydown', event => { if (!['ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); const names = state.providers.map(item=>item.alias), next=index+(event.key==='ArrowUp'?-1:1); if(next<0 || next>=names.length)return; [names[index],names[next]]=[names[next],names[index]]; run('order',names).catch(()=>{}); });
    row.append(handle);
    const identity = node('div', null, 'identity'); identity.append(node('strong', provider.alias), node('small', provider.type === 'account' ? t('account') : provider.baseUrl)); row.append(identity);
    if (provider.active) row.append(node('span', t('active'), 'tag'));
    if (provider.needsLogin) row.append(button(t('signIn'), () => startLogin(provider.alias)));
    row.append(button(provider.active ? t('selected') : t('use'), () => run('switch', provider.alias), provider.active ? 'secondary' : ''));
    const remove = button('', async () => { if (confirm(t('removeConfirm', {alias:provider.alias}))) await run('remove', provider.alias); }, 'icon-button delete-provider');
    remove.append(icon('trash')); remove.setAttribute('aria-label', t('remove',{alias:provider.alias})); row.append(remove); $('provider-list').append(row);
  });
}
function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
  try {
    state = await call('state'); appearance();
    $('status').textContent = t(state.running ? 'routingActive' : 'routingStopped'); $('status').classList.toggle('stopped', !state.running);
    $('current-provider').textContent = state.active || t('addProvider');
    const customized = state.sessions.filter(session => session.overridden).length;
    $('current-model').textContent = customized ? t('sessionSummary', { count: customized }) : state.model ? `${state.model.model} · ${state.model.effort || t('providerDefault')}` : t('followCodex');
    $('routing-toggle').textContent = t(state.running ? 'stopRouting' : 'startRouting');
    $('version').textContent = `easy-switch ${state.version}`; $('tray-hint').hidden = !state.menuBarHidden; renderUpdate(); $('autostart').checked = !!state.loginItem;
    if (state.error) showError(state.error);
    renderProviders();
    $('failover').hidden = !state.lastFailover;
    if (state.lastFailover) $('failover').textContent = t('lastFailover', state.lastFailover);
    renderLogin(); renderNetwork(); renderSessions(); renderCatalogStatus();
    if (catalogAlias && catalogAlias !== state.active && activeTab === 'model') notice('catalogChanged');
    else notice(catalogNotice, rawNotice);
    if (catalogAlias === state.active && !modelDirty) {
      $('model-select').value = targetSelection()?.model || ''; efforts();
    }
  } catch (error) { showError(error); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function efforts() {
  const entry = catalog.find(model => model.id === $('model-select').value);
  const selection = targetSelection();
  $('effort-select').value = selection && selection.model === entry?.id ? selection.effort || '' : entry?.defaultEffort || '';
  renderModelPicker(); renderEfforts();
}
function targetSelection() { return modelTarget === 'global' ? state.model : state.sessions.find(session => session.id === modelTarget)?.selection; }
function selectSession(id) {
  modelTarget = id; modelDirty = false; modelFeedback = null; closeModelPicker();
  $('model-select').value = targetSelection()?.model || ''; efforts(); renderSessions(); renderCatalogStatus();
}
function renderSessions() {
  const sessions = state.sessions || [];
  if (modelTarget && modelTarget !== 'global' && !sessions.some(session => session.id === modelTarget)) {
    modelTarget = null; modelDirty = false; modelFeedback = null; closeModelPicker();
    $('model-select').value = ''; efforts();
  }
  const signature = JSON.stringify([language, modelTarget, sessions]);
  if (signature !== renderedSessions) {
    renderedSessions = signature; $('session-list').replaceChildren();
    for (const session of sessions) {
      const option = button('', () => selectSession(session.id), 'secondary session-option');
      option.dataset.session = session.id; option.setAttribute('aria-pressed', String(modelTarget === session.id));
      const copy = node('span', null, 'session-copy');
      const shortID = session.id.length > 18 ? `${session.id.slice(0, 8)}…${session.id.slice(-6)}` : session.id;
      copy.append(node('strong', session.title || t('unnamedSession')),
        node('small', `${shortID} · ${session.model || session.clientModel || '—'}${session.provider ? ' · ' + session.provider : ''}`));
      option.title = session.id;
      const status = node('span', t(session.activeRequests ? 'sessionRunning' : 'sessionWaiting'), `session-state${session.activeRequests ? ' running' : ''}`);
      option.append(copy, status); if (session.overridden) copy.append(node('small', `${t('sessionOverride')} · ${session.selection ? session.selection.model + ' · ' + (session.selection.effort || t('providerDefault')) : t('followCodex')}`));
      $('session-list').append(option);
    }
  }
  $('sessions-empty').hidden = !!sessions.length;
  $('sessions-unavailable').hidden = !state.sessionsUnavailable;
  $('global-model').setAttribute('aria-pressed', String(modelTarget === 'global'));
  const session = sessions.find(item => item.id === modelTarget);
  $('model-target').textContent = modelTarget === 'global' ? t('globalTarget') : session ? t('sessionTarget', { title: session.title || session.id }) : t('chooseSessionHelp');
  $('model-feedback').hidden = !modelFeedback;
  if (modelFeedback) $('model-feedback').textContent = t(modelFeedback.global ? 'globalModelApplied' : 'modelApplied', modelFeedback);
}
function renderModelPicker() {
  const id = $('model-select').value, entry = catalog.find(model => model.id === id);
  $('model-picker-label').textContent = id ? entry?.label || id : t('followCodex');
  $('model-picker-id').textContent = entry && entry.label !== id ? id : '';
  $('model-picker-id').hidden = !$('model-picker-id').textContent;
  $('model-choice-help').textContent = t(id ? 'selectedModelHelp' : 'followCodexHelp');
}
function renderEfforts() {
  const model = $('model-select').value, entry = catalog.find(item => item.id === model), selected = $('effort-select').value;
  const signature = JSON.stringify([language, model, entry?.efforts, selected]); if (signature === effortSignature) return;
  effortSignature = signature; $('effort-options').replaceChildren();
  for (const value of ['', ...(entry?.efforts || [])]) {
    const option = button(value ? (t('effort_' + value) === 'effort_' + value ? value : t('effort_' + value)) : t(model ? 'providerDefault' : 'followCodex'), () => {
      $('effort-select').value = value; modelDirty = true; renderEfforts();
      [...$('effort-options').children].find(item => item.dataset.effort === value)?.focus();
    }, 'secondary effort-option');
    option.type = 'button'; option.dataset.effort = value; option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(value === selected)); option.disabled = !model;
    option.tabIndex = value === selected ? 0 : -1;
    option.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const options = [...$('effort-options').children], index = options.indexOf(option);
      options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length].click();
    });
    $('effort-options').append(option);
  }
  $('effort-help').textContent = t(!model ? 'followCodexHelp' : !entry?.efforts.length ? 'unknownEffortHelp' : 'effortHelp');
}
function closeModelPicker() { $('model-menu').hidden = true; $('model-picker').setAttribute('aria-expanded', 'false'); }
function openModelPicker() {
  const menu = $('model-menu'), viewport = document.querySelector('main').getBoundingClientRect();
  menu.classList.remove('above'); menu.hidden = false;
  $('model-picker').setAttribute('aria-expanded', 'true'); $('model-search').value = ''; renderModelOptions();
  const trigger = $('model-picker').getBoundingClientRect();
  menu.classList.toggle('above', menu.getBoundingClientRect().bottom > viewport.bottom && trigger.top - viewport.top > viewport.bottom - trigger.bottom);
  $('model-search').focus();
}
function renderModelOptions() {
  const query = $('model-search').value.trim().toLowerCase(); $('model-options').replaceChildren();
  const options = [{ id: '', label: t('followCodex'), description: t('followCodexHelp') }, ...catalog]
    .filter(entry => !entry.id || `${entry.id} ${entry.label}`.toLowerCase().includes(query));
  for (const entry of options) {
    const option = button('', () => {
      $('model-select').value = entry.id; modelDirty = true; efforts(); closeModelPicker(); $('model-picker').focus();
    }, 'model-option');
    option.type = 'button'; option.dataset.model = entry.id; option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(entry.id === $('model-select').value));
    const copy = node('span'); copy.append(node('strong', entry.label));
    if (entry.description || entry.label !== entry.id) copy.append(node('small', entry.description || entry.id));
    option.append(copy); if (entry.id === $('model-select').value) option.append(icon('check'));
    $('model-options').append(option);
  }
  $('model-empty').hidden = options.length > 1 || !query;
}
function renderCatalogStatus() {
  $('refresh-models-label').textContent = t(catalogLoading ? 'catalogLoading' : 'refreshCatalog');
  $('refresh-models').classList.toggle('loading', catalogLoading);
  const target = modelTarget === 'global' || state?.sessions.some(session => session.id === modelTarget);
  $('model-picker').disabled = !target;
  $('reset-model').disabled = !target;
  $('apply-model').disabled = !target || catalogLoading || catalogAlias !== state?.active || catalogFailed;
  $('catalog-status').classList.toggle('failed', catalogFailed);
  const changed = catalogLoaded && catalogLoaded.alias !== state?.active;
  $('catalog-status').textContent = catalogLoading ? t('catalogLoading') : catalogFailed ? t('catalogFailed') : changed ? t('catalogChanged') : catalogLoaded
    ? t('catalogRefreshed', { count: catalogLoaded.count, time: new Date(catalogLoaded.at).toLocaleTimeString(language) }) : '';
}
async function loadModels() {
  if (catalogLoading) return;
  catalogLoading = true; catalogFailed = false; $('refresh-models').disabled = true; renderCatalogStatus(); notice('catalogLoading');
  try {
    const alias = (await call('state')).active;
    const result = await call('models');
    if ((await call('state')).active !== alias) throw new Error(t('catalogChanged'));
    catalog = result.models; catalogAlias = alias; catalogLoaded = { alias, at: Date.now(), count: catalog.length };
    $('model-select').value = targetSelection()?.model || ''; efforts(); notice(result.notice || '', true); modelDirty = false;
  } catch (error) { catalogFailed = true; notice(error.message, true); }
  finally { catalogLoading = false; $('refresh-models').disabled = false; renderCatalogStatus(); }
}
async function changeTab(tab) {
  if(tab==='updates') {await showUpdates();return;}
  if (!['providers', 'model', 'network'].includes(tab)) return;
  activeTab = tab;
  for (const element of document.querySelectorAll('nav button')) element.classList.toggle('selected', element.dataset.tab === tab);
  for (const id of ['providers', 'model', 'network']) $(id).hidden = id !== tab;
  if (tab === 'model' && (!catalogAlias || catalogAlias !== state.active)) await loadModels();
  if (tab === 'network') {
    try {
      networkState = await call('network');
      const proxy = networkState.httpsProxy || networkState.httpProxy || '';
      const address = proxy ? new URL(proxy) : null;
      $('proxy-username').value = address ? decodeCredential(address.username) : '';
      $('proxy-password').value = address ? decodeCredential(address.password) : '';
      if (address) { address.username = ''; address.password = ''; }
      $('proxy-url').value = address?.href || '';
      $('no-proxy').value = networkState.noProxy;
      renderNetwork();
    }
    catch (error) { showError(error); }
  }
}
async function startLogin(alias) {
  if (!$('add-dialog').open) openProvider('account', alias);
  const result = await run('login', alias);
  if (result?.login?.url) await call('open-login');
  return result;
}
function decodeCredential(value) { try { return decodeURIComponent(value); } catch { return value; } }
function renderNetwork() {
  if (!networkState) return;
  $('local-proxy').textContent = networkState.localProxy.url;
  $('local-proxy-status').textContent = t(state.running ? 'localProxyActive' : 'localProxyStopped');
  $('detected-proxy').textContent = networkState.detected.url || t('noneDetected');
  const source = networkState.detected.source === 'environment' ? t('proxyEnvironment') : networkState.detected.source;
  $('detected-proxy-source').textContent = networkState.source === 'saved' ? t('proxySaved')
    : networkState.detected.url ? t('proxyDetectedFrom', { source }) : t('proxyDetectedNone');
  $('proxy-warning').hidden = !networkState.unsupported;
}
function dialogLogin() { return providerMode === 'account' && state.login?.alias === $('provider-alias').value.trim() ? state.login : null; }
function renderLogin() {
  const login = dialogLogin(), pending = login && ['starting', 'pending'].includes(login.phase);
  $('login-status').hidden = !login;
  $('provider-alias').disabled = !!pending;
  $('save-provider').disabled = !!pending;
  if (providerMode === 'import' && importLoading) $('save-provider').disabled = true;
  $('save-provider').textContent = t(login?.phase === 'complete' ? 'done' : providerMode === 'api' ? 'addAPI' : providerMode === 'import' ? 'importAction' : 'addSubscription');
  $('login-code').textContent = pending ? login.code || '' : '';
  $('open-login').hidden = !pending || !login.url;
  if (!login) return;
  $('login-alias').textContent = `${login.alias} · ${t('phase' + login.phase[0].toUpperCase() + login.phase.slice(1))}`;
  $('login-message').textContent = pending && login.code ? t('loginInstructions') : localizeMessage(login.message, language);
}
for (const element of document.querySelectorAll('nav button')) element.addEventListener('click', () => changeTab(element.dataset.tab));
function openProvider(mode, alias = '') {
  providerMode = mode; $('dialog-error').hidden = true; $('provider-form').reset();
  const pending = state.login && ['starting', 'pending'].includes(state.login.phase);
  $('provider-alias').value = alias || (mode === 'account' && pending ? state.login.alias : '');
  $('import-preview').hidden = true;
  providerType(); renderLogin(); $('add-dialog').showModal();
}
$('add-subscription').addEventListener('click',()=>openProvider('account'));
$('add-api').addEventListener('click',()=>openProvider('api'));
$('import-existing').addEventListener('click', async () => {
  openProvider('import'); importLoading = true; renderLogin();
  try {
    const existing = await call('existing-login');
    if (providerMode !== 'import' || !$('add-dialog').open) return;
    $('provider-alias').value = existing.alias; $('import-preview').hidden = false;
    $('import-preview').textContent = `${t(existing.type === 'api' ? 'detectedAPI' : 'detectedAccount')}${existing.baseUrl ? ' · ' + existing.baseUrl : ''}`;
  } catch (error) { if (providerMode === 'import' && $('add-dialog').open) showError(error, 'dialog-error'); }
  finally { importLoading = false; renderLogin(); }
});
$('close-dialog').addEventListener('click', () => $('add-dialog').close());
function providerType() {
  const api = providerMode === 'api', imported = providerMode === 'import'; $('api-fields').hidden = !api; $('account-help').hidden = api;
  $('account-help').textContent = t(imported ? 'importHelp' : 'subscriptionHelp');
  $('provider-dialog-title').textContent = t(api ? 'addAPI' : imported ? 'importExisting' : 'addSubscription');
  $('save-provider').textContent = t(api ? 'addAPI' : imported ? 'importAction' : 'addSubscription');
}
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-provider').disabled = true; $('dialog-error').hidden = true;
  try {
    if (dialogLogin()?.phase === 'complete') { $('add-dialog').close(); return; }
    const alias = $('provider-alias').value.trim();
    if (providerMode === 'api') { await call('add-api', { alias, url: $('base-url').value.trim(), key: $('api-key').value }); $('api-key').value = ''; $('add-dialog').close(); }
    else if (providerMode === 'import') { await call('import-login',alias); $('add-dialog').close(); }
    else { await startLogin(alias); }
    await refresh();
  } catch (error) { showError(error, 'dialog-error'); }
  finally { renderLogin(); }
});
$('provider-alias').addEventListener('input', renderLogin);
$('provider-list').addEventListener('dragover', event => {
  if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  const row = event.target.closest('.provider'), moving = [...$('provider-list').children].find(item=>item.dataset.alias===dragging);
  if (!row || row === moving) return;
  const bounds = row.getBoundingClientRect(); if(event.clientY<bounds.top+bounds.height/2) row.before(moving); else row.after(moving);
});
$('provider-list').addEventListener('drop', async event => {
  if (!dragging) return; event.preventDefault(); $('provider-list').querySelector('.dragging')?.classList.remove('dragging'); const aliases=[...$('provider-list').children].map(item=>item.dataset.alias); dragging=null;
  try { await run('order',aliases); } catch {} finally { renderedProviders=''; renderProviders(); }
});
$('model-picker').addEventListener('click', () => { if (!$('model-menu').hidden) closeModelPicker(); else openModelPicker(); });
$('model-search').addEventListener('input', renderModelOptions);
$('model-search').addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); $('model-options').firstElementChild?.focus(); } });
$('model-options').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const options = [...$('model-options').children], index = options.indexOf(document.activeElement);
  options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
});
$('refresh-models').addEventListener('click', loadModels);
$('global-model').addEventListener('click', () => selectSession('global'));
async function saveModel(selection) {
  const target = modelTarget, session = state.sessions.find(item => item.id === target);
  if (target !== 'global' && !session) return;
  await run(target === 'global' ? 'model' : 'session-model', target === 'global' ? selection : { sessionId: target, selection });
  if (modelTarget !== target) return;
  modelDirty = false; modelFeedback = { global: target === 'global', title: session?.title || target };
  $('model-select').value = targetSelection()?.model || ''; efforts(); renderSessions();
}
$('model-form').addEventListener('submit', async event => {
  event.preventDefault(); const model = $('model-select').value;
  try { await saveModel(model ? { model, effort: $('effort-select').value || null } : null); } catch {}
});
$('reset-model').addEventListener('click', async () => { try { await saveModel(null); } catch {} });
$('network-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.activeRequests && !confirm(t('restartConfirm'))) return;
  try {
    let proxy = $('proxy-url').value.trim();
    if (proxy) { const url = new URL(proxy); url.username = $('proxy-username').value; url.password = $('proxy-password').value; proxy = url.href; }
    await run('save-network', { proxy, noProxy: $('no-proxy').value.trim() }); await changeTab('network');
  } catch (error) { showError(error); }
});
function closeMenus() { for(const id of ['language','theme']) { $(id+'-menu').hidden=true; $(id+'-button').setAttribute('aria-expanded','false'); } }
for(const id of ['language','theme']) $(id+'-button').addEventListener('click',()=>{const open=$(id+'-menu').hidden;closeMenus();$(id+'-menu').hidden=!open;$(id+'-button').setAttribute('aria-expanded',String(open));if(open)$(id+'-menu').querySelector('button').focus();});
for(const item of document.querySelectorAll('[data-language],button[data-theme]')) item.addEventListener('click',async()=>{closeMenus();try{await run('preferences',item.dataset.language?{language:item.dataset.language}:{theme:item.dataset.theme});}catch{}});
document.addEventListener('click',event=>{if(!event.target.closest('.icon-control'))closeMenus();if(!event.target.closest('.model-picker'))closeModelPicker();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeMenus();if(!$('model-menu').hidden){event.preventDefault();closeModelPicker();$('model-picker').focus();}}});
$('autostart').addEventListener('change', async event => { try { await run('autostart', event.target.checked); } catch {} });
$('routing-toggle').addEventListener('click', async () => {
  if (state.running && state.activeRequests && !confirm(t('stopConfirm'))) return;
  try { await run(state.running ? 'stop' : 'start'); } catch {}
});
$('open-login').addEventListener('click', () => call('open-login').catch(showError));
function formattedBytes(value) { return `${(value / 1024 ** 2).toLocaleString(language, { maximumFractionDigits: 1 })} MB`; }
function appendNoteText(element, text) {
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    if (part.startsWith('`')) element.append(node('code', part.slice(1, -1)));
    else if (part.startsWith('**')) element.append(node('strong', part.slice(2, -2)));
    else element.append(document.createTextNode(part));
  }
}
function renderReleaseNotes(notes) {
  $('update-notes').replaceChildren(); let list;
  if (!notes) { $('update-notes').append(node('p', t('updateNotesMissing'))); return; }
  for (const line of notes.split('\n')) {
    const text = line.trim(); if (!text || text.startsWith('<!--')) continue;
    if (/^[-*] /.test(text)) {
      if (!list) { list = node('ul'); $('update-notes').append(list); }
      const item = node('li'); appendNoteText(item, text.slice(2)); list.append(item);
    } else {
      list = null; const element = node(/^#+ /.test(text) ? 'h4' : 'p');
      appendNoteText(element, text.replace(/^#+ /, '')); $('update-notes').append(element);
    }
  }
}
function renderUpdate() {
  const update = state.update || { phase: 'idle' }, phase = update.phase;
  const busy = ['checking', 'downloading', 'installing'].includes(phase);
  $('update-dialog').dataset.phase = phase;
  $('update-dot').hidden = !['available', 'ready'].includes(phase);
  $('update-current').textContent = `easy-switch ${state.version}`;
  const titles = { checking: 'updateChecking', current: 'updateCurrent', available: 'updateAvailable', downloading: 'updateDownloading', ready: 'updateReady', installing: 'updateInstall', error: 'updateFailed' };
  const percent = Math.min(100, Math.floor(100 * (update.received || 0) / (update.total || 1)));
  $('update-title').textContent = t(titles[phase] || 'updateIdle', { version: update.version, percent });
  const subtitle = { current: update.checkedAt ? 'updateCheckedAt' : 'updateCurrentHelp', available: 'updateReview', ready: 'updateReadyHelp', error: 'updateFailedHelp' }[phase] || 'updateIdleHelp';
  $('update-status').textContent = t(subtitle, { time: update.checkedAt ? new Date(update.checkedAt).toLocaleTimeString(language) : '' });
  $('update-symbol').setAttribute('href', `assets/ui.svg#${phase === 'current' || phase === 'ready' ? 'check' : phase === 'error' ? 'close' : phase === 'available' || phase === 'downloading' ? 'download' : 'refresh'}`);
  $('update-emblem').classList.toggle('spinning', phase === 'checking');
  $('update-transfer').hidden = phase !== 'downloading'; $('update-progress').value = percent;
  $('update-bytes').textContent = `${formattedBytes(update.received || 0)} / ${formattedBytes(update.total || 0)}`;
  $('update-error').hidden = !update.error; if (update.error) $('update-error').textContent = localizeMessage(update.error, language);
  $('update-action').hidden = !['available', 'ready', 'downloading', 'installing'].includes(phase) && !update.retryDownload;
  $('update-action').disabled = busy; $('update-action').textContent = t(update.retryDownload ? 'retryDownload' : phase === 'ready' || phase === 'installing' ? 'updateInstall' : 'updateDownload');
  $('update-retry').disabled = busy;
  $('update-warning').hidden = !['available', 'ready', 'downloading', 'installing'].includes(phase);
  $('update-metadata').hidden = !update.version;
  $('update-metadata').textContent = [update.version ? `${state.version} → ${update.version}` : '', update.date ? new Date(update.date).toLocaleDateString(language) : '', update.size ? formattedBytes(update.size) : ''].filter(Boolean).join(' · ');
  $('update-changes').hidden = !update.version;
  const signature = JSON.stringify([language, update.version, update.notes]);
  if (signature !== renderedUpdate) { renderedUpdate = signature; renderReleaseNotes(releaseNotes(update.notes, language)); }
}
async function showUpdates() { if(!$('update-dialog').open)$('update-dialog').showModal();try{await run('updates');}catch{} }
$('updates').addEventListener('click',showUpdates); $('update-retry').addEventListener('click',showUpdates);
$('close-update').addEventListener('click',()=>$('update-dialog').close());
$('update-action').addEventListener('click',async()=>{try{await call(state.update.phase==='ready'?'update-install':'update-download');}catch(error){showError(error,'update-error');}finally{await refresh();}});
$('star').addEventListener('click',()=>call('star').catch(showError));
window.easySwitch.onChange(refresh);
window.easySwitch.onTab(changeTab);
refresh();
