import { translate, normalizeLanguage, localizeMessage } from './i18n.js';
const $ = id => document.getElementById(id);
let state, catalog = [], catalogAlias = null, activeTab = 'providers', renderedProviders = '', refreshing = false, modelDirty = false;
let language = 'en', appliedLanguage, catalogNotice = 'loadCatalog', rawNotice = false;
const t = (key, values) => translate(language, key, values);
function appearance() {
  language = normalizeLanguage(state.language);
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  document.documentElement.dataset.platform = state.platform;
  $('language-select').value = language; $('theme-select').value = state.theme;
  if (appliedLanguage === language) return;
  appliedLanguage = language;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of document.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  $('language-select').setAttribute('aria-label', t('language')); $('theme-select').setAttribute('aria-label', t('appearance'));
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
  try { const result = await call(action, payload); await refresh(); return result; }
  catch (error) { showError(error); throw error; }
}
function node(tag, text, className) {
  const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element;
}
function button(text, handler, className = 'secondary') {
  const element = node('button', text, className); element.addEventListener('click', () => Promise.resolve(handler()).catch(() => {})); return element;
}
function renderProviders() {
  const signature = JSON.stringify([language, state.providers]);
  if (signature === renderedProviders) return;
  renderedProviders = signature; $('provider-list').replaceChildren(); $('empty').hidden = !!state.providers.length;
  state.providers.forEach((provider, index) => {
    const row = node('div', null, `provider${provider.active ? ' active' : ''}`);
    row.append(node('span', String(index + 1), 'number'));
    const identity = node('div', null, 'identity'); identity.append(node('strong', provider.alias), node('small', provider.type === 'account' ? t('account') : provider.baseUrl)); row.append(identity);
    if (provider.active) row.append(node('span', t('active'), 'tag'));
    if (provider.needsLogin) row.append(button(t('signIn'), () => startLogin(provider.alias)));
    row.append(button(provider.active ? t('selected') : t('use'), () => run('switch', provider.alias), provider.active ? 'secondary' : ''));
    const priority = node('div', null, 'priority');
    for (const [text, offset] of [['↑', -1], ['↓', 1]]) {
      const move = button(text, () => {
        const aliases = state.providers.map(item => item.alias); const next = index + offset;
        [aliases[index], aliases[next]] = [aliases[next], aliases[index]]; return run('order', aliases);
      });
      move.setAttribute('aria-label', t(offset < 0 ? 'moveUp' : 'moveDown', { alias: provider.alias }));
      move.disabled = index + offset < 0 || index + offset >= state.providers.length; priority.append(move);
    }
    row.append(priority); $('provider-list').append(row);
  });
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await call('state'); appearance();
    $('status').textContent = t(state.running ? 'routingActive' : 'routingStopped'); $('status').classList.toggle('stopped', !state.running);
    $('current-provider').textContent = state.active || t('addProvider');
    $('current-model').textContent = state.model ? `${state.model.model} · ${state.model.effort || t('providerDefault')}` : t('followCodex');
    $('routing-toggle').textContent = t(state.running ? 'stopRouting' : 'startRouting');
    $('version').textContent = `v${state.version}`; $('autostart').checked = !!state.loginItem;
    if (state.error) showError(state.error);
    renderProviders();
    $('failover').hidden = !state.lastFailover;
    if (state.lastFailover) $('failover').textContent = t('lastFailover', state.lastFailover);
    $('login-status').hidden = !state.login;
    if (state.login) {
      $('login-alias').textContent = `${state.login.alias} · ${t('phase' + state.login.phase[0].toUpperCase() + state.login.phase.slice(1))}`;
      $('login-message').textContent = localizeMessage(state.login.message, language); $('login-code').textContent = state.login.code || '';
      $('open-login').hidden = !state.login.url || ['complete', 'failed'].includes(state.login.phase);
    }
    if (catalogAlias && catalogAlias !== state.active && activeTab === 'model') notice('catalogChanged');
    else notice(catalogNotice, rawNotice);
    if (catalogAlias === state.active && !modelDirty) {
      $('model-select').value = state.model?.model || ''; efforts();
    }
  } catch (error) { showError(error); }
  finally { refreshing = false; }
}
function efforts() {
  const entry = catalog.find(model => model.id === $('model-select').value);
  $('effort-select').replaceChildren(new Option(t('providerDefault'), ''));
  for (const effort of entry?.efforts || []) $('effort-select').add(new Option(effort, effort));
  $('effort-select').disabled = !entry;
  $('effort-select').value = state.model && state.model.model === entry?.id ? state.model.effort || '' : entry?.defaultEffort || '';
}
async function loadModels() {
  $('refresh-models').disabled = true; notice('catalogLoading');
  try {
    const alias = state.active;
    const result = await call('models'); catalog = result.models; catalogAlias = alias;
    $('model-select').replaceChildren(new Option(t('followCodex'), ''));
    for (const model of catalog) $('model-select').add(new Option(`${model.label} (${model.id})`, model.id));
    $('model-select').value = state.model?.model || ''; efforts(); notice(result.notice || '', true); modelDirty = false;
  } catch (error) { showError(error); notice('catalogFailed'); }
  finally { $('refresh-models').disabled = false; }
}
async function changeTab(tab) {
  if (!['providers', 'model', 'network'].includes(tab)) return;
  activeTab = tab;
  for (const element of document.querySelectorAll('nav button')) element.classList.toggle('selected', element.dataset.tab === tab);
  for (const id of ['providers', 'model', 'network']) $(id).hidden = id !== tab;
  if (tab === 'model' && (!catalogAlias || catalogAlias !== state.active)) await loadModels();
  if (tab === 'network') {
    try { const network = await call('network'); $('proxy-url').value = network.httpsProxy || network.httpProxy || ''; $('no-proxy').value = network.noProxy; }
    catch (error) { showError(error); }
  }
}
async function startLogin(alias) {
  const result = await run('login', alias);
  if (result?.login?.url) await call('open-login');
}
for (const element of document.querySelectorAll('nav button')) element.addEventListener('click', () => changeTab(element.dataset.tab));
$('add-provider').addEventListener('click', () => { $('dialog-error').hidden = true; $('provider-form').reset(); providerType(); $('add-dialog').showModal(); });
$('close-dialog').addEventListener('click', () => $('add-dialog').close());
function providerType() {
  const api = $('provider-type').value === 'api'; $('api-fields').hidden = !api; $('account-help').hidden = api; $('import-login').hidden = api;
  $('save-provider').textContent = t(api ? 'addAPI' : 'signInChatGPT');
}
$('provider-type').addEventListener('change', providerType);
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-provider').disabled = true; $('dialog-error').hidden = true;
  try {
    if ($('provider-type').value === 'api') await call('add-api', { alias: $('provider-alias').value.trim(), url: $('base-url').value.trim(), key: $('api-key').value });
    else await startLogin($('provider-alias').value.trim());
    $('api-key').value = ''; $('add-dialog').close(); await refresh();
  } catch (error) { showError(error, 'dialog-error'); }
  finally { $('save-provider').disabled = false; }
});
$('import-login').addEventListener('click', async () => {
  try { await call('import-login', $('provider-alias').value.trim()); $('add-dialog').close(); await refresh(); }
  catch (error) { showError(error, 'dialog-error'); }
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
  try { await run('save-network', { proxy: $('proxy-url').value.trim(), noProxy: $('no-proxy').value.trim() }); } catch {}
});
$('language-select').addEventListener('change', async event => { try { await run('preferences', { language: event.target.value }); } catch {} });
$('theme-select').addEventListener('change', async event => { try { await run('preferences', { theme: event.target.value }); } catch {} });
$('autostart').addEventListener('change', async event => { try { await run('autostart', event.target.checked); } catch {} });
$('routing-toggle').addEventListener('click', async () => {
  if (state.running && state.activeRequests && !confirm(t('stopConfirm'))) return;
  try { await run(state.running ? 'stop' : 'start'); } catch {}
});
$('open-login').addEventListener('click', () => call('open-login').catch(showError));
$('updates').addEventListener('click', () => call('updates').catch(showError));
$('quit').addEventListener('click', () => call('quit').catch(showError));
window.easySwitch.onChange(refresh);
window.easySwitch.onTab(changeTab);
refresh();
