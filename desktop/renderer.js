import { translate, normalizeLanguage, localizeMessage } from './i18n.js';
const $ = id => document.getElementById(id);
let state, catalog = [], catalogAlias = null, activeTab = 'providers', renderedProviders = '', refreshing = null, modelDirty = false;
let language = 'en', appliedLanguage, catalogNotice = 'loadCatalog', rawNotice = false, providerMode = 'account', dragging = null, renderedUpdate = '';
let networkState = null;
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
  $('model-select').querySelector('option[value=""]').textContent = t('followCodex');
  $('effort-select').querySelector('option[value=""]').textContent = t('providerDefault');
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
    $('current-model').textContent = state.model ? `${state.model.model} · ${state.model.effort || t('providerDefault')}` : t('followCodex');
    $('routing-toggle').textContent = t(state.running ? 'stopRouting' : 'startRouting');
    $('version').textContent = `easy-switch ${state.version}`; $('tray-hint').hidden = !state.menuBarHidden; renderUpdate(); $('autostart').checked = !!state.loginItem;
    if (state.error) showError(state.error);
    renderProviders();
    $('failover').hidden = !state.lastFailover;
    if (state.lastFailover) $('failover').textContent = t('lastFailover', state.lastFailover);
    renderLogin(); renderNetwork();
    if (catalogAlias && catalogAlias !== state.active && activeTab === 'model') notice('catalogChanged');
    else notice(catalogNotice, rawNotice);
    if (catalogAlias === state.active && !modelDirty) {
      $('model-select').value = state.model?.model || ''; efforts();
    }
  } catch (error) { showError(error); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function efforts() {
  const entry = catalog.find(model => model.id === $('model-select').value);
  $('effort-select').replaceChildren(new Option(t('providerDefault'), ''));
  for (const effort of entry?.efforts || []) $('effort-select').add(new Option(effort, effort));
  $('effort-select').disabled = !entry?.efforts.length;
  $('effort-select').value = state.model && state.model.model === entry?.id ? state.model.effort || '' : entry?.defaultEffort || '';
}
async function loadModels() {
  $('refresh-models').disabled = true; notice('catalogLoading');
  try {
    const alias = state.active;
    const result = await call('models'); catalog = result.models; catalogAlias = alias;
    $('model-select').replaceChildren(new Option(t('followCodex'), ''));
    for (const model of catalog) $('model-select').add(new Option(model.label === model.id ? model.id : `${model.label} (${model.id})`, model.id));
    $('model-select').value = state.model?.model || ''; efforts(); notice(result.notice || '', true); modelDirty = false;
  } catch (error) { showError(error); notice('catalogFailed'); }
  finally { $('refresh-models').disabled = false; }
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
      $('proxy-url').value = networkState.httpsProxy || networkState.httpProxy || '';
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
  providerType(); renderLogin(); $('add-dialog').showModal();
}
$('add-subscription').addEventListener('click',()=>openProvider('account'));
$('add-api').addEventListener('click',()=>openProvider('api'));
$('import-existing').addEventListener('click',()=>openProvider('import'));
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
$('model-select').addEventListener('change', () => { modelDirty = true; efforts(); });
$('effort-select').addEventListener('change', () => { modelDirty = true; });
$('refresh-models').addEventListener('click', loadModels);
$('model-form').addEventListener('submit', async event => {
  event.preventDefault(); const model = $('model-select').value;
  try { await run('model', model ? { model, effort: $('effort-select').value || null } : null); modelDirty = false; } catch {}
});
$('reset-model').addEventListener('click', async () => { try { await run('model', null); $('model-select').value = ''; efforts(); modelDirty = false; } catch {} });
$('network-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.activeRequests && !confirm(t('restartConfirm'))) return;
  try { await run('save-network', { proxy: $('proxy-url').value.trim(), noProxy: $('no-proxy').value.trim() }); await changeTab('network'); } catch {}
});
function closeMenus() { for(const id of ['language','theme']) { $(id+'-menu').hidden=true; $(id+'-button').setAttribute('aria-expanded','false'); } }
for(const id of ['language','theme']) $(id+'-button').addEventListener('click',()=>{const open=$(id+'-menu').hidden;closeMenus();$(id+'-menu').hidden=!open;$(id+'-button').setAttribute('aria-expanded',String(open));if(open)$(id+'-menu').querySelector('button').focus();});
for(const item of document.querySelectorAll('[data-language],button[data-theme]')) item.addEventListener('click',async()=>{closeMenus();try{await run('preferences',item.dataset.language?{language:item.dataset.language}:{theme:item.dataset.theme});}catch{}});
document.addEventListener('click',event=>{if(!event.target.closest('.icon-control'))closeMenus();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenus();});
$('autostart').addEventListener('change', async event => { try { await run('autostart', event.target.checked); } catch {} });
$('routing-toggle').addEventListener('click', async () => {
  if (state.running && state.activeRequests && !confirm(t('stopConfirm'))) return;
  try { await run(state.running ? 'stop' : 'start'); } catch {}
});
$('open-login').addEventListener('click', () => call('open-login').catch(showError));
function renderUpdate() {
  const update = state.update || {phase:'idle'};
  $('update-dot').hidden = !['available','ready'].includes(update.phase);
  $('update-current').textContent = `easy-switch ${state.version}`;
  $('update-title').textContent = t(update.version ? 'updateAvailable' : update.phase==='current' ? 'updateCurrent' : 'updateIdle', {version:update.version});
  const key={checking:'updateChecking',downloading:'updateDownloading',ready:'updateReady',installing:'updateInstall',current:'updateCurrent',error:'updateFailed'}[update.phase];
  $('update-status').textContent = key ? t(key,{percent:Math.min(100,Math.floor(100*(update.received||0)/(update.total||1)))}) : '';
  $('update-progress').hidden=update.phase!=='downloading'; $('update-progress').value=100*(update.received||0)/(update.total||1);
  $('update-error').hidden=!update.error; if(update.error)$('update-error').textContent=localizeMessage(update.error,language);
  $('update-action').hidden=!['available','ready','downloading','installing'].includes(update.phase);
  $('update-action').disabled=['downloading','installing'].includes(update.phase); $('update-action').textContent=t(update.phase==='ready'?'updateInstall':'updateDownload');
  $('update-retry').disabled=['downloading','checking','installing'].includes(update.phase);
  const signature=JSON.stringify([update.version,update.notes]); if(signature!==renderedUpdate){renderedUpdate=signature;$('update-notes').replaceChildren();for(const line of (update.notes||'').split('\n')) if(line.trim()) $('update-notes').append(node(/^#+ /.test(line)?'h3':'p',line.replace(/^#+ /,'')));}
}
async function showUpdates() { if(!$('update-dialog').open)$('update-dialog').showModal();try{await run('updates');}catch{} }
$('updates').addEventListener('click',showUpdates); $('update-retry').addEventListener('click',showUpdates);
$('close-update').addEventListener('click',()=>$('update-dialog').close());
$('update-action').addEventListener('click',async()=>{try{await run(state.update.phase==='ready'?'update-install':'update-download');}catch{}});
$('star').addEventListener('click',()=>call('star').catch(showError));
window.easySwitch.onChange(refresh);
window.easySwitch.onTab(changeTab);
refresh();
