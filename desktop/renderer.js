import { translate, normalizeLanguage, localizeMessage } from './i18n.js';
import { releaseNotes } from './release-notes.js';
import { claudeFamilies } from '../src/claude-models.js';
import { planLabel } from '../src/plans.js';
const $ = id => document.getElementById(id);
const mappingFields = { ...Object.fromEntries(claudeFamilies.map(role => [role, `claude-${role}-model`])), default: 'claude-main-model', subagent: 'claude-agent-model' };
function showMapping(mapping = {}) {
  for (const [role, id] of Object.entries(mappingFields)) $(id).value = mapping?.[role] || '';
}
let state, renderedProviders = '', refreshing = null;
let language = 'en', appliedLanguage, providerMode = 'account', dragging = null, renderedUpdate = '';
let importLoading = false;
let catalogProvider = null, catalogResult = null, catalogLoading = false, catalogError = '', catalogRequest = 0;
let catalogDraft = [], catalogMapping = {}, catalogCustom = false, catalogDirty = false, catalogDrag = null;
let resetAlias = null, resetData = null, resetSelected = null, resetBusy = false, resetLoading = false, resetAttempt = null, resetOutcome = null;
let renderedState = '';
let editingProvider = null, settingsOpen = false;
const resetAttempts = new Map();
const t = (key, values) => translate(language, state?.client === 'claude' && ['baseHint', 'subscriptionHelp', 'importHelp'].includes(key) ? 'claude_' + key : key, values)
  .replaceAll('Codex', state?.client === 'claude' ? 'Claude' : 'Codex').replaceAll('ChatGPT', state?.client === 'claude' ? 'Claude' : 'ChatGPT');
function appearance() {
  language = normalizeLanguage(state.language);
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  document.documentElement.dataset.platform = state.platform;
  $('theme-symbol').setAttribute('href', `assets/ui.svg#${state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'monitor'}`);
  for (const item of document.querySelectorAll('[data-language]')) item.setAttribute('aria-checked', String(item.dataset.language === language));
  for (const item of document.querySelectorAll('[data-theme]')) if (item.tagName === 'BUTTON') item.setAttribute('aria-checked', String(item.dataset.theme === state.theme));
  if (appliedLanguage === language + state.client) return;
  appliedLanguage = language + state.client;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of document.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  $('language-button').title = t('language'); $('theme-button').title = t('appearance');
  $('updates').title = t('updates'); $('star').title = t('star');
  renderProviderModels();
  for (const element of document.querySelectorAll('[data-error]')) element.textContent = localizeMessage(element.dataset.error, language);
  providerType(); renderResetCards();
}
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
function quotaRing(data, tooltip) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('class', 'quota-ring');
  const plus = data.plan === 'plus' || !!data.fiveHour && !!data.weekly && !['pro', 'prolite', 'promax'].includes(data.plan);
  const depleted = !data.unlimited && data.credits === 0 && [data.fiveHour, data.weekly].some(window => window?.remaining === 0);
  if (depleted) {
    svg.classList.add('depleted');
    const outline = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: 24, cy: 24, r: 20, class: 'quota-exhausted-outline' })) outline.setAttribute(key, value);
    svg.append(outline);
  }
  const windows = plus ? ['fiveHour', 'weekly'] : [data.weekly ? 'weekly' : data.fiveHour ? 'fiveHour' : 'weekly'];
  const descriptions = [];
  for (const name of windows) {
    const weekly = name === 'weekly';
    const value = weekly ? data.weekly : data.fiveHour, label = t(weekly ? 'quotaWeek' : 'quotaFiveHour');
    const percent = value ? new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value.remaining) : '—';
    let description = value ? t('quotaRemaining', { label, percent }) : t('quotaNotProvided', { label });
    if (value?.resetsAt) description += '\n' + t('quotaResets', { time: new Date(value.resetsAt).toLocaleString(language) });
    descriptions.push(description);
    const group = document.createElementNS(svg.namespaceURI, 'g');
    group.setAttribute('class', `quota-segment${value ? value.remaining === 0 ? ' exhausted' : '' : ' unknown'}${weekly ? ' weekly' : ''}${value && value.remaining <= 20 ? ' low' : ''}`);
    group.setAttribute('role', 'img'); group.setAttribute('aria-label', description); group.setAttribute('tabindex', '0');
    for (const progress of [false, true]) {
      const shape = document.createElementNS(svg.namespaceURI, plus ? 'path' : 'circle');
      const attributes = plus ? { d: weekly ? 'M42.271 15.865 A20 20 0 1 1 5.729 15.865' : 'M7.820 12.244 A20 20 0 0 1 40.180 12.244' } : { cx: 24, cy: 24, r: 20, transform: 'rotate(-90 24 24)' };
      for (const [key, val] of Object.entries({ ...attributes, pathLength: 100, class: progress ? 'quota-progress' : 'quota-track' })) shape.setAttribute(key, val);
      if (progress) { if (!value || value.remaining === 0) shape.setAttribute('visibility', 'hidden'); shape.setAttribute('stroke-dasharray', '100'); shape.setAttribute('stroke-dashoffset', value ? 100 - value.remaining : 100); }
      group.append(shape);
    }
    const hit = group.firstChild.cloneNode(); hit.setAttribute('class', 'quota-hit'); group.append(hit);
    group.addEventListener('mouseenter', () => { tooltip.textContent = description; tooltip.hidden = false; });
    group.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    group.addEventListener('focus', () => { tooltip.textContent = description; tooltip.hidden = false; });
    group.addEventListener('blur', () => { tooltip.hidden = true; });
    svg.append(group);
  }
  const center = document.createElementNS(svg.namespaceURI, 'g');
  const balance = data.unlimited ? '∞' : Number.isFinite(data.credits) ? new Intl.NumberFormat(language, { maximumFractionDigits: 3 }).format(data.credits) : null;
  const creditDescription = balance === null ? t('creditsNotProvided') : `${t('quotaCredits')}\n${balance}`;
  const description = depleted ? [t('quotaExhausted'), ...descriptions, creditDescription].join('\n') : creditDescription;
  center.setAttribute('class', 'quota-center'); center.setAttribute('tabindex', '0');
  center.setAttribute('role', 'img'); center.setAttribute('aria-label', description);
  const mark = document.createElementNS(svg.namespaceURI, depleted ? 'path' : 'rect');
  const attributes = depleted ? { d: 'M24 16v9m0 6v.1', class: 'quota-exhausted-mark' } : { x: 18, y: 18, width: 12, height: 12, rx: 2, transform: 'rotate(45 24 24)' };
  for (const [key, value] of Object.entries(attributes)) mark.setAttribute(key, value);
  const hit = document.createElementNS(svg.namespaceURI, 'circle');
  for (const [key, value] of Object.entries({ cx: 24, cy: 24, r: 10, class: 'quota-center-hit' })) hit.setAttribute(key, value);
  center.append(mark, hit);
  center.addEventListener('mouseenter', () => { tooltip.textContent = description; tooltip.hidden = false; });
  center.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  center.addEventListener('focus', () => { tooltip.textContent = description; tooltip.hidden = false; });
  center.addEventListener('blur', () => { tooltip.hidden = true; });
  svg.append(center);
  return svg;
}
function quotaDisplay(provider) {
  const usage = provider.usage, data = usage?.data;
  const box = node('div', null, 'quota');
  box.setAttribute('role', 'group');
  if (!data) {
    box.append(node('span', t(usage?.status === 'signin' ? 'loginNeeded' : usage?.status === 'unavailable' ? 'quotaUnavailable' : 'quotaLoading'), 'quota-message'));
  } else {
    const tooltip = node('span', null, 'quota-tooltip'); tooltip.hidden = true; tooltip.id = `quota-tip-${provider.alias}`; tooltip.setAttribute('role', 'tooltip');
    box.append(quotaRing(data, tooltip), tooltip);
  }
  let description = t('quotaAutoRefresh');
  if (usage?.fetchedAt) description += '\n' + t('quotaUpdated', { time: new Date(usage.fetchedAt).toLocaleTimeString(language) });
  if (data && usage.status !== 'ready') { box.classList.add('stale'); description += '\n' + t('quotaStale'); }
  box.setAttribute('aria-label', description);
  if (!data || usage.status !== 'ready') box.title = description;
  if (usage?.refreshing) box.setAttribute('aria-busy', 'true');
  return box;
}
const providerAnimations = new WeakMap();
function providerPositions() {
  return new Map([...$('provider-list').children].map(row => [row.dataset.alias, row.getBoundingClientRect().top]));
}
function animateProviders(before) {
  for (const row of $('provider-list').children) providerAnimations.get(row)?.cancel();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const row of $('provider-list').children) {
    const distance = before.get(row.dataset.alias) - row.getBoundingClientRect().top;
    if (!Number.isFinite(distance) || Math.abs(distance) < 1) continue;
    providerAnimations.set(row, row.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }));
  }
}
function renderProviders() {
  const signature = JSON.stringify([language, state.client, state.providers]);
  if (signature === renderedProviders || dragging) return;
  const before = providerPositions();
  renderedProviders = signature; $('provider-list').replaceChildren(); $('empty').hidden = !!state.providers.length;
  state.providers.forEach((provider, index) => {
    const row = node('div', null, `provider${provider.active ? ' active' : ''}`);
    row.dataset.alias = provider.alias;
    const handle = button('', () => {}, 'drag-handle'); handle.append(icon('grip')); handle.draggable = true; handle.setAttribute('aria-label', t('drag', {alias: provider.alias}));
    handle.addEventListener('dragstart', event => { dragging = provider.alias; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', provider.alias); event.dataTransfer.setDragImage(row, 20, 20); });
    handle.addEventListener('dragend', () => { if (dragging) { dragging = null; renderedProviders = ''; renderProviders(); } });
    handle.addEventListener('keydown', event => { if (!['ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); const names = state.providers.map(item=>item.alias), next=index+(event.key==='ArrowUp'?-1:1); if(next<0 || next>=names.length)return; [names[index],names[next]]=[names[next],names[index]]; run('order',names).catch(()=>{}); });
    row.append(handle);
    const identity = node('div', null, 'identity');
    const plan = provider.usage?.data?.plan || provider.plan, label = planLabel(plan, state.client);
    const detail = node('small', provider.type === 'account' ? label ? `${state.client === 'claude' ? 'Claude' : 'ChatGPT'} ${label}` : state.client === 'claude' ? t('claudePlanUnknown') : t('account') : provider.baseUrl);
    if (provider.type === 'account') detail.title = state.client === 'claude' ? t(label ? 'claudePlanCached' : 'claudePlanUnknownHelp') : label ? t(provider.usage?.data?.plan ? 'planLive' : 'planCached') : '';
    if (provider.plan && provider.usage?.data?.plan && provider.plan !== provider.usage.data.plan) detail.title = t('planMismatch', { cached: planLabel(provider.plan, state.client), live: label });
    identity.append(node('strong', provider.alias), detail); row.append(identity);
    if (provider.type === 'account' && state.client !== 'claude') {
      row.append(quotaDisplay(provider));
      const reset = button('', () => openResetCards(provider.alias), 'icon-button reset-quota'); reset.append(icon('refresh'));
      reset.title = t('resetQuota'); reset.setAttribute('aria-label', t('resetQuota')); row.append(reset);
    }
    if (provider.needsLogin) row.append(button(t('signIn'), () => startLogin(provider.alias)));
    const select = button('', () => provider.active ? undefined : run('switch', provider.alias), 'icon-button select-provider');
    select.append(icon(provider.active ? 'check' : 'switch')); select.setAttribute('aria-pressed', String(provider.active));
    select.title = t(provider.active ? 'selected' : 'use'); select.setAttribute('aria-label', `${select.title} · ${provider.alias}`); row.append(select);
    const query = button('', () => openProviderModels(provider.alias), 'icon-button query-models');
    query.append(icon('search')); query.title = t('queryModels'); query.setAttribute('aria-label', t('queryModels') + ' · ' + provider.alias); row.append(query);
    const edit = button('', () => openProvider('edit', provider.alias), 'icon-button edit-provider');
    edit.append(icon('edit')); edit.title = t('editProvider'); edit.setAttribute('aria-label', t('editProvider') + ' · ' + provider.alias); row.append(edit);
    const remove = button('', async () => { if (confirm(t('removeConfirm', {alias:provider.alias}))) await run('remove', provider.alias); }, 'icon-button delete-provider');
    remove.append(icon('trash')); remove.setAttribute('aria-label', t('remove',{alias:provider.alias})); row.append(remove); $('provider-list').append(row);
  });
  animateProviders(before);
}
function renderResetCards() {
  if (!resetAlias) return;
  $('reset-title').textContent = t('resetAccount', { alias: resetAlias });
  $('reset-status').textContent = t(resetLoading ? 'resetLoading' : resetData?.availableCount == null ? 'resetUnknown' : 'resetCount', { count: resetData?.availableCount });
  $('reset-card-list').replaceChildren();
  for (const card of resetData?.credits || []) {
    const available = card.status === 'available' && card.resetType === 'codexRateLimits' && (!card.expiresAt || card.expiresAt > Date.now());
    const option = button('', () => { resetSelected = card.id; renderResetCards(); }, 'secondary reset-card');
    option.dataset.creditId = card.id; option.setAttribute('role', 'radio'); option.setAttribute('aria-checked', String(resetSelected === card.id));
    option.disabled = !available || resetBusy || !!resetAttempt;
    const copy = node('span', null, 'reset-card-copy');
    copy.append(node('strong', card.title || t('resetCard')), node('small', card.expiresAt ? t('resetExpires', { time: new Date(card.expiresAt).toLocaleString(language) }) : t(card.expiryKnown ? 'resetNoExpiry' : 'resetExpiryUnknown')));
    if (!available) copy.append(node('small', t(card.expiresAt && card.expiresAt <= Date.now() ? 'resetExpired' : 'resetUnavailable')));
    if (card.description) copy.append(node('small', card.description));
    option.append(node('span', null, 'reset-card-check'), copy); $('reset-card-list').append(option);
  }
  $('reset-card-help').textContent = t(!resetLoading && resetData?.availableCount > 0 && !resetData?.credits?.length ? 'resetDetailsMissing' : 'resetCardHelp');
  $('reset-result').hidden = !resetOutcome;
  if (resetOutcome) $('reset-result').textContent = t('reset_' + resetOutcome);
  $('reset-confirm').textContent = t(resetBusy ? 'resetWorking' : resetAttempt ? 'resetRetry' : 'resetConfirm');
  const card = resetData?.credits?.find(card => card.id === resetSelected);
  $('reset-confirm').disabled = resetLoading || resetBusy || !resetAttempt && (!card || card.status !== 'available' || card.resetType !== 'codexRateLimits' || card.expiresAt && card.expiresAt <= Date.now());
  $('reset-reload').disabled = resetBusy || !!resetAttempt;
  $('close-reset').disabled = resetBusy;
}
async function loadResetCards() {
  const alias = resetAlias; resetLoading = true; resetSelected = resetAttempt?.creditId || null; resetData = null; resetOutcome = null; $('reset-error').hidden = true; renderResetCards();
  try { const result = await call('reset-cards', alias); if (alias === resetAlias) resetData = result; }
  catch (error) { if (alias === resetAlias) showError(error, 'reset-error'); }
  finally { if (alias === resetAlias) { resetLoading = false; renderResetCards(); } }
}
async function openResetCards(alias) {
  resetAlias = alias; resetAttempt = resetAttempts.get(alias) || null; $('reset-dialog').showModal(); await loadResetCards();
}
$('close-reset').addEventListener('click', () => $('reset-dialog').close());
$('reset-dialog').addEventListener('cancel', event => { if (resetBusy) event.preventDefault(); });
$('reset-reload').addEventListener('click', loadResetCards);
$('reset-confirm').addEventListener('click', async () => {
  if (resetBusy || !resetSelected) return;
  resetAttempt ??= { alias: resetAlias, creditId: resetSelected, idempotencyKey: crypto.randomUUID() };
  resetAttempts.set(resetAlias, resetAttempt);
  resetBusy = true; $('reset-error').hidden = true; renderResetCards();
  try {
    const result = await call('consume-reset', resetAttempt);
    resetOutcome = result.outcome; resetData = result.cards; resetSelected = null; resetAttempt = null; resetAttempts.delete(resetAlias);
    await refresh();
  } catch (error) { showError(error, 'reset-error'); }
  finally { resetBusy = false; renderResetCards(); }
});
function refresh(nextState) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
  try {
    state = nextState || await call('state');
    const signature = JSON.stringify(state);
    if (signature === renderedState) return;
    renderedState = signature; appearance(); showSettings(settingsOpen);
    for (const item of document.querySelectorAll('[data-client]')) item.setAttribute('aria-pressed', String(!settingsOpen && item.dataset.client === (state.client || 'codex')));
    for (const name of ['codex', 'claude']) {
      const route = state.clients?.[name] || { running: state.running, active: name === (state.client || 'codex') ? state.active : null };
      const item = document.querySelector(`[data-client-item="${name}"]`), control = document.querySelector(`[data-routing-client="${name}"]`);
      item.classList.toggle('selected', !settingsOpen && name === (state.client || 'codex'));
      const provider = item.querySelector('.client-provider'); provider.textContent = route.active || '—'; provider.title = route.active || t('noProvider');
      control.setAttribute('aria-checked', String(route.running));
      control.setAttribute('aria-label', `${name === 'codex' ? 'Codex' : 'Claude'} · ${t(route.running ? 'stopRouting' : 'startRouting')}`);
      control.title = control.getAttribute('aria-label');
    }
    $('status').textContent = t(state.running ? 'routingActive' : 'routingStopped'); $('status').classList.toggle('stopped', !state.running);
    $('current-provider').textContent = state.active || t('addProvider');
    $('version').textContent = `easy-switch ${state.version}`; $('tray-hint').hidden = !state.menuBarHidden; renderUpdate(); $('autostart').setAttribute('aria-checked', String(!!state.loginItem));
    $('preferences-warning').hidden = !state.preferencesError;
    $('preferences-warning').textContent = state.preferencesError ? t('preferencesUnavailable', { code: state.preferencesError }) : '';
    $('native-images').hidden = !state.imageToolsBlocked;
    if (state.error) showError(state.error);
    renderProviders();
    $('failover').hidden = !state.lastFailover;
    if (state.lastFailover) $('failover').textContent = t('lastFailover', state.lastFailover);
    renderLogin();
    if (catalogProvider && (catalogProvider.client !== state.client || !state.providers.some(provider => provider.alias === catalogProvider.alias))) {
      $('models-dialog').close(); catalogProvider = null; catalogRequest++;
    }
  } catch (error) { showError(error); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function catalogChanged() {
  catalogCustom = true; catalogDirty = true;
  $('models-save').disabled = false;
  $('models-mode').textContent = t('customCatalog');
}
function renderProviderModels() {
  if (!catalogProvider) return;
  $('models-provider').textContent = `${catalogProvider.client === 'claude' ? 'Claude' : 'Codex'} · ${catalogProvider.alias}`;
  $('models-title').textContent = t('modelCatalog');
  $('models-refresh').disabled = catalogLoading;
  $('models-refresh').classList.toggle('loading', catalogLoading);
  $('models-save').disabled = !catalogDirty || catalogLoading;
  $('models-mode').textContent = t(catalogCustom ? 'customCatalog' : 'automaticCatalog');
  $('models-status').classList.toggle('failed', !!catalogError);
  $('models-status').textContent = catalogLoading ? t('catalogLoading') : catalogError ? localizeMessage(catalogError, language) : catalogResult
    ? t('catalogRefreshed', { count: catalogResult.discovered.length, time: new Date(catalogResult.fetchedAt).toLocaleTimeString(language) }) : '';
  const query = $('models-search').value.trim().toLowerCase();
  $('models-list').replaceChildren();
  const options = [...new Map([...(catalogResult?.discovered || []), ...catalogDraft].filter(entry => entry.id).map(entry => [entry.id, entry])).values()];
  for (const id of ['claude-model-options', 'catalog-model-options']) $(id).replaceChildren(...options.map(entry => {
    const option = node('option', entry.label || entry.id); option.value = entry.id; return option;
  }));
  const reorder = (index, next) => {
    if (next < 0 || next >= catalogDraft.length || index === next) return;
    const before = new Map([...$('models-list').children].map(row => [row.dataset.index, row.getBoundingClientRect().top]));
    const [entry] = catalogDraft.splice(index, 1); catalogDraft.splice(next, 0, entry);
    catalogChanged(); renderProviderModels();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const row of $('models-list').children) {
      const old = Number(row.dataset.index) === next ? index : Number(row.dataset.index) + (index < next && Number(row.dataset.index) >= index && Number(row.dataset.index) < next ? 1 : index > next && Number(row.dataset.index) > next && Number(row.dataset.index) <= index ? -1 : 0);
      const distance = before.get(String(old)) - row.getBoundingClientRect().top;
      if (distance) row.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  };
  catalogDraft.forEach((entry, index) => {
    if (query && !`${entry.id} ${entry.label}`.toLowerCase().includes(query)) return;
    const row = node('div', null, 'catalog-model'); row.setAttribute('role', 'listitem'); row.dataset.index = index;
    const grip = button('', () => {}, 'drag-handle'); grip.append(icon('grip')); grip.draggable = true;
    grip.setAttribute('aria-label', t('reorderModel', { index: index + 1 }));
    grip.addEventListener('dragstart', event => { catalogDrag = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.setDragImage(row, 16, 16); row.classList.add('dragging'); });
    grip.addEventListener('dragend', () => { catalogDrag = null; row.classList.remove('dragging'); });
    grip.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); reorder(index, index + (event.key === 'ArrowUp' ? -1 : 1)); });
    row.addEventListener('dragover', event => { if (catalogDrag !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
    row.addEventListener('drop', event => { event.preventDefault(); if (catalogDrag !== null) reorder(catalogDrag, index); catalogDrag = null; });
    row.append(grip);
    for (const [field, key] of [['id', 'modelID'], ['label', 'modelDisplayName']]) {
      const input = node('input'); input.value = entry[field] || ''; input.placeholder = t(key); input.autocomplete = 'off';
      input.className = field === 'id' ? 'catalog-id' : 'catalog-label';
      input.setAttribute('aria-label', `${t(key)} ${index + 1}`); input.maxLength = field === 'id' ? 200 : 120;
      input.addEventListener('input', () => { entry[field] = input.value; catalogChanged(); }); row.append(input);
    }
    const remove = button('', () => { catalogDraft.splice(index, 1); catalogChanged(); renderProviderModels(); }, 'icon-button delete-model');
    remove.append(icon('trash')); remove.setAttribute('aria-label', t('removeModel', { index: index + 1 })); row.append(remove);
    $('models-list').append(row);
  });
  const mappings = catalogProvider.client === 'claude' && catalogProvider.type === 'api';
  $('catalog-mappings').hidden = !mappings;
  $('catalog-family-fields').replaceChildren();
  if (mappings) for (const role of claudeFamilies) {
    const label = node('label'), input = node('input');
    label.append(node('span', `${role[0].toUpperCase() + role.slice(1)} →`));
    input.id = `catalog-${role}`; input.setAttribute('list', 'catalog-model-options'); input.value = catalogMapping[role] || '';
    input.placeholder = t('familyMappingHint'); input.autocomplete = 'off';
    input.addEventListener('input', () => { catalogMapping[role] = input.value.trim(); catalogDirty = true; $('models-save').disabled = false; });
    label.append(input); $('catalog-family-fields').append(label);
  }
  $('models-empty').hidden = catalogLoading || !!$('models-list').children.length;
  $('models-empty').textContent = t(query ? 'noMatchingModels' : 'noModelsReported');
  $('models-notice').textContent = t('catalogEditorHelp') + (catalogResult ? ' ' + localizeMessage(catalogResult.notice, language) : '');
}
async function loadProviderModels(importModels = false) {
  if (!catalogProvider) return;
  const request = ++catalogRequest, provider = catalogProvider;
  catalogLoading = true; catalogError = ''; renderProviderModels();
  try {
    const result = await call('models', provider.alias);
    if (request !== catalogRequest) return;
    catalogResult = result;
    if (importModels && catalogCustom) {
      const ids = new Set(catalogDraft.map(entry => entry.id));
      catalogDraft.push(...result.discovered.filter(entry => !ids.has(entry.id)).map(({ id, label }) => ({ id, label })));
      catalogDirty = true;
    } else if (!catalogDirty || importModels) catalogDraft = result.models.map(({ id, label }) => ({ id, label }));
  } catch (error) { if (request === catalogRequest) catalogError = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { if (request === catalogRequest) { catalogLoading = false; renderProviderModels(); } }
}
async function openProviderModels(alias) {
  const provider = state.providers.find(item => item.alias === alias);
  catalogProvider = { ...provider, client: state.client };
  catalogDraft = (provider.modelCatalog || []).map(entry => ({ ...entry }));
  catalogMapping = { ...provider.claudeModels }; catalogCustom = Array.isArray(provider.modelCatalog); catalogDirty = false;
  catalogResult = null; catalogError = ''; $('models-search').value = ''; $('catalog-mappings').open = false;
  renderProviderModels(); $('models-dialog').showModal(); await loadProviderModels();
}
$('close-models').addEventListener('click', () => $('models-dialog').close());
$('models-cancel').addEventListener('click', () => $('models-dialog').close());
$('models-dialog').addEventListener('close', () => { catalogProvider = null; catalogRequest++; catalogLoading = false; catalogDrag = null; });
$('models-refresh').addEventListener('click', () => loadProviderModels(true));
$('models-search').addEventListener('input', renderProviderModels);
$('models-add').addEventListener('click', () => { catalogDraft.push({ id: '', label: '' }); $('models-search').value = ''; catalogChanged(); renderProviderModels(); $('models-list').lastElementChild?.querySelector('input')?.focus(); });
$('models-reset').addEventListener('click', async () => {
  catalogCustom = false; catalogDirty = true;
  if (!catalogResult) await loadProviderModels();
  catalogDraft = (catalogResult?.discovered || []).map(({ id, label }) => ({ id, label })); renderProviderModels();
});
$('models-save').addEventListener('click', async () => {
  const provider = catalogProvider; if (!provider) return;
  $('models-save').disabled = true; catalogError = '';
  try {
    await run('edit', { original: provider.alias, alias: provider.alias, expectedRevision: provider.revision,
      modelCatalog: catalogCustom ? catalogDraft.map(({ id, label }) => ({ id: id.trim(), label: label.trim() })) : null,
      ...(provider.client === 'claude' && provider.type === 'api' ? { claudeModels: catalogMapping } : {}) });
    if (editingProvider?.alias === provider.alias) {
      editingProvider = state.providers.find(item => item.alias === provider.alias); showMapping(editingProvider.claudeModels);
    }
    $('models-dialog').close();
  } catch (error) { catalogError = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); renderProviderModels(); }
});
async function startLogin(alias) {
  if (!$('add-dialog').open) openProvider('account', alias);
  const result = await run('login', alias);
  if (result?.login?.url && !(state.client === 'claude' && state.platform === 'win32')) await call('open-login');
  return result;
}
function dialogLogin() { return providerMode === 'account' && state.login?.alias === $('provider-alias').value.trim() ? state.login : null; }
function renderLogin() {
  const login = dialogLogin(), pending = login && ['starting', 'pending'].includes(login.phase);
  $('login-status').hidden = !login;
  $('provider-alias').disabled = !!pending;
  $('save-provider').disabled = !!pending && !login.codeRequired;
  $('claude-code-field').hidden = !pending || !login.codeRequired;
  if (providerMode === 'import' && importLoading) $('save-provider').disabled = true;
  $('save-provider').textContent = t(providerMode === 'edit' ? 'saveChanges' : login?.phase === 'complete' ? 'done' : login?.codeRequired ? 'completeSignIn' : providerMode === 'api' ? 'addAPI' : providerMode === 'import' ? 'importAction' : 'addSubscription');
  $('login-code').textContent = pending ? login.code || '' : '';
  $('open-login').hidden = !pending || !login.url;
  if (!login) return;
  $('login-alias').textContent = `${login.alias} · ${t('phase' + login.phase[0].toUpperCase() + login.phase.slice(1))}`;
  $('login-message').textContent = pending && login.code ? t('loginInstructions') : localizeMessage(login.message, language);
}
function openProvider(mode, alias = '') {
  providerMode = mode; $('dialog-error').hidden = true; $('provider-form').reset();
  editingProvider = mode === 'edit' ? state.providers.find(provider => provider.alias === alias) : null;
  const pending = state.login && ['starting', 'pending'].includes(state.login.phase);
  $('provider-alias').value = alias || (mode === 'account' && pending ? state.login.alias : '');
  $('base-url').value = editingProvider?.baseUrl || '';
  showMapping(editingProvider?.claudeModels);
  $('claude-mapping').open = state.client === 'claude';
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
$('claude-choose-model').addEventListener('click', () => openProviderModels(editingProvider.alias));
function providerType() {
  const api = providerMode === 'api' || editingProvider?.type === 'api', imported = providerMode === 'import'; $('api-fields').hidden = !api; $('account-help').hidden = api || providerMode === 'edit';
  $('edit-key-help').hidden = providerMode !== 'edit';
  $('claude-mapping').hidden = !api || state.client !== 'claude' || providerMode !== 'edit';
  $('claude-choose-model').hidden = !editingProvider || editingProvider.type !== 'api';
  $('account-help').textContent = t(imported ? 'importHelp' : 'subscriptionHelp');
  $('provider-dialog-title').textContent = t(providerMode === 'edit' ? 'editProvider' : api ? 'addAPI' : imported ? 'importExisting' : 'addSubscription');
  $('save-provider').textContent = t(api ? 'addAPI' : imported ? 'importAction' : 'addSubscription');
}
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-provider').disabled = true; $('dialog-error').hidden = true;
  try {
    if (dialogLogin()?.phase === 'complete') { $('add-dialog').close(); return; }
    const alias = $('provider-alias').value.trim();
    const mapping = providerMode === 'edit' && state.client === 'claude' ? { claudeModels: Object.fromEntries(Object.entries(mappingFields).map(([role, id]) => [role, $(id).value.trim()])) } : {};
    if (providerMode === 'edit') { await call('edit', { original: editingProvider.alias, alias, url: $('base-url').value.trim(), key: $('api-key').value, ...mapping }); $('api-key').value = ''; $('add-dialog').close(); }
    else if (dialogLogin()?.codeRequired) { await call('login-code', $('authorization-code').value.trim()); $('authorization-code').value = ''; }
    else if (providerMode === 'api') { await call('add-api', { alias, url: $('base-url').value.trim(), key: $('api-key').value, ...mapping }); $('api-key').value = ''; $('add-dialog').close(); }
    else if (providerMode === 'import') { await call('import-login',alias); $('add-dialog').close(); }
    else { await startLogin(alias); }
    await refresh();
  } catch (error) { showError(error, 'dialog-error'); }
  finally { renderLogin(); }
});
$('provider-alias').addEventListener('input', renderLogin);
function showSettings(open) {
  settingsOpen = open;
  document.querySelector('.workspace-title h1').textContent = t(open ? 'settings' : 'yourProviders');
  document.querySelector('.workspace-title p').textContent = t(open ? 'settingsHelp' : 'clientHelp');
  $('providers-page').hidden = open; $('settings-page').hidden = !open;
  $('settings').setAttribute('aria-pressed', String(open));
  document.querySelector('.workspace-route').hidden = open;
  for (const item of document.querySelectorAll('[data-client]')) item.setAttribute('aria-pressed', String(!open && item.dataset.client === state.client));
  for (const item of document.querySelectorAll('[data-client-item]')) item.classList.toggle('selected', !open && item.dataset.clientItem === state.client);
}
$('settings').addEventListener('click', () => showSettings(true));
for (const item of document.querySelectorAll('[data-client]')) item.addEventListener('click', async () => {
  showSettings(false);
  if (item.dataset.client === state.client) return;
  $('add-dialog').close(); $('reset-dialog').close(); editingProvider = null; providerMode = 'account';
  $('models-dialog').close(); catalogProvider = null; catalogRequest++;
  try { await run('client', item.dataset.client); } catch {}
});
$('provider-list').addEventListener('dragover', event => {
  if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  const row = event.target.closest('.provider'), moving = [...$('provider-list').children].find(item=>item.dataset.alias===dragging);
  if (!row || row === moving) return;
  // Use layout positions for the threshold; an animating row's visual position
  // must not make the same pointer position repeatedly reverse the order.
  const top = row.offsetTop - $('provider-list').offsetTop + $('provider-list').getBoundingClientRect().top;
  const above = event.clientY < top + row.offsetHeight / 2;
  if (above ? row.previousElementSibling === moving : row.nextElementSibling === moving) return;
  const before = providerPositions();
  if (above) row.before(moving); else row.after(moving);
  animateProviders(before);
});
$('provider-list').addEventListener('drop', async event => {
  if (!dragging) return; event.preventDefault(); $('provider-list').querySelector('.dragging')?.classList.remove('dragging'); const aliases=[...$('provider-list').children].map(item=>item.dataset.alias); dragging=null;
  try { await run('order',aliases); } catch {} finally { renderedProviders=''; renderProviders(); }
});
function closeMenus() { for(const id of ['language','theme']) { $(id+'-menu').hidden=true; $(id+'-button').setAttribute('aria-expanded','false'); } }
for(const id of ['language','theme']) $(id+'-button').addEventListener('click',()=>{const open=$(id+'-menu').hidden;closeMenus();$(id+'-menu').hidden=!open;$(id+'-button').setAttribute('aria-expanded',String(open));if(open)$(id+'-menu').querySelector('button').focus();});
for(const item of document.querySelectorAll('[data-language],button[data-theme]')) item.addEventListener('click',async()=>{closeMenus();try{await run('preferences',item.dataset.language?{language:item.dataset.language}:{theme:item.dataset.theme});}catch{}});
document.addEventListener('click', event => { if (!event.target.closest('.icon-control')) closeMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
$('autostart').addEventListener('click', async event => {
  const control = event.currentTarget; control.disabled = true;
  try { await run('autostart', !state.loginItem); } catch {} finally { control.disabled = false; }
});
for (const control of document.querySelectorAll('[data-routing-client]')) control.addEventListener('click', async () => {
  const client = control.dataset.routingClient, route = state.clients?.[client] || { running: state.running, activeRequests: state.activeRequests };
  if (route.running && route.activeRequests && !confirm(t('stopConfirm'))) return;
  control.disabled = true;
  try { await run('routing', { client, enabled: !route.running }); } catch {} finally { control.disabled = false; }
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
window.easySwitch.onChange(nextState => { if (!document.hidden) refresh(nextState); });
window.easySwitch.onShow(() => { if (document.activeElement?.closest('.sidebar')) document.activeElement.blur(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.easySwitch.onTab(tab => { if (tab === 'updates') showUpdates(); else showSettings(tab === 'settings'); });
refresh();
