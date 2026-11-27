import { element as $ } from './dom.js';
import { translate, localizeMessage, type Language } from './i18n.js';
import type { DesktopBridge, DesktopResult } from './ipc.js';
import type { UsageFilter } from '../src/usage-stats.js';

export function usageStatsUI({ call, language }: { call: DesktopBridge['call']; language: () => Language }) {
  const t = (key: string) => translate(language(), key);
  let signature = '';
  let data: DesktopResult<'usage-stats'>, metric = 'requests', busy = false, request = 0;
  let filter: UsageFilter = { days: 7, client: 'all', group: 'requests', page: 0 };
  let timer: ReturnType<typeof setTimeout>;
  let pending = false;
  const visible = () => !$('usage-page').hidden && !$('settings-page').hidden && !document.hidden;
  const integer = (value: number) => new Intl.NumberFormat(language(), { maximumFractionDigits: 0 }).format(value);
  const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const money = (value: number) => value > 0 && value < .000001 ? '<$0.000001' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value && value < .01 ? 6 : value < 1 ? 4 : 2 }).format(value);
  const percent = (value: number, total: number) => total ? new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 1 }).format(value / total) : '—';
  const element = (tag: string, text?: string, className?: string) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  function error(value) { $('usage-error').textContent = localizeMessage(String(value.message || value), language()); $('usage-error').hidden = false; }
  let helpButton: HTMLElement, pinned = false;
  function hideHelp() { $('usage-tooltip').hidden = true; helpButton?.removeAttribute('aria-describedby'); helpButton = undefined; pinned = false; }
  function showHelp(button: HTMLElement) {
    if (!data) return;
    helpButton?.removeAttribute('aria-describedby'); helpButton = button; button.setAttribute('aria-describedby', 'usage-tooltip');
    const name = button.dataset.usageHelp, key = { cost: 'usageCost', requests: 'usageRequests', tokens: 'usageTokens', cache: 'usageCache' }[name];
    $('usage-tooltip-title').textContent = t(key + 'HelpTitle');
    $('usage-tooltip-text').textContent = t(key + 'Help');
    const tip = $('usage-tooltip'), rect = button.getBoundingClientRect();
    tip.hidden = false; tip.style.width = Math.min(280, window.innerWidth - 32) + 'px';
    tip.style.left = Math.max(16, Math.min(rect.right - tip.offsetWidth, window.innerWidth - tip.offsetWidth - 16)) + 'px';
    tip.style.top = (rect.top - tip.offsetHeight > 16 ? rect.top - tip.offsetHeight - 8 : Math.min(rect.bottom + 8, window.innerHeight - tip.offsetHeight - 16)) + 'px';
  }
  for (const button of document.querySelectorAll<HTMLElement>('[data-usage-help]')) {
    button.addEventListener('mouseenter', () => { if (!pinned) showHelp(button); });
    button.addEventListener('mouseleave', () => { if (!pinned && document.activeElement !== button) hideHelp(); });
    button.addEventListener('focus', () => { if (helpButton !== button) pinned = false; showHelp(button); });
    button.addEventListener('blur', hideHelp);
    button.addEventListener('click', () => { if (pinned && helpButton === button) hideHelp(); else { pinned = true; showHelp(button); } });
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideHelp(); });
  document.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('[data-usage-help]')) hideHelp(); });
  document.addEventListener('scroll', hideHelp, true); window.addEventListener('resize', hideHelp);
  const columns = [
    ['time', 'usageTime', true], ['app', 'usageApp', true], ['provider', 'usageProvider', true], ['model', 'usageModel', true],
    ['cost', 'usageCost', true], ['input', 'usageFreshInput', true], ['output', 'usageOutputTokens', true], ['cached', 'usageCacheReads', true],
    ['cacheWrite', 'usageCacheWrites', false], ['speed', 'usageSpeed', true], ['firstToken', 'usageFirstToken', true],
    ['duration', 'usageDuration', false], ['status', 'usageStatus', false],
  ] as const;
  let columnSettings: Record<string, boolean> = {};
  try { columnSettings = JSON.parse(localStorage.getItem('usage-columns') || '{}'); } catch {}
  const selectedColumns = () => columns.filter(([id, , enabled]) => id === 'time' || (columnSettings[id] ?? enabled));
  function columnMenu() {
    $('usage-column-options').replaceChildren(...columns.filter(([id]) => id !== 'time').map(([id, key, enabled]) => {
      const label = element('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = columnSettings[id] ?? enabled;
      input.addEventListener('change', () => { columnSettings[id] = input.checked; try { localStorage.setItem('usage-columns', JSON.stringify(columnSettings)); } catch {} signature = ''; render(); });
      label.append(input, element('span', t(key))); return label;
    }));
  }
  $('usage-columns-button').addEventListener('click', () => {
    columnMenu(); const rect = $('usage-columns-button').getBoundingClientRect(), menu = $('usage-columns');
    menu.style.right = Math.max(16, window.innerWidth - rect.right) + 'px'; menu.style.top = Math.min(rect.bottom + 6, window.innerHeight - 360) + 'px';
  });
  function render() {
    if (!data) return;
    const nextSignature = JSON.stringify([data.summary, data.daily, data.rows, data.page, data.source, columnSettings, metric, language()]);
    $('usage-updated').textContent = new Date(data.updatedAt).toLocaleTimeString(language(), { hour: '2-digit', minute: '2-digit' });
    if (nextSignature === signature) return; signature = nextSignature;
    const { summary } = data;
    for (const badge of document.querySelectorAll<HTMLElement>('[data-usage-count]')) badge.textContent = integer(data.counts[badge.dataset.usageCount]);
    $('usage-columns-button').hidden = filter.group !== 'requests';
    $('usage-cost').textContent = summary.priced ? money(summary.cost) : '—';
    $('usage-requests').textContent = integer(summary.requests);
    $('usage-tokens').textContent = summary.reported ? compact(summary.input + summary.output) : '—';
    $('usage-cache').textContent = summary.cacheReported ? percent(summary.cached, summary.cacheInput) : '—';
    $('usage-tokens').title = summary.reported ? `${integer(summary.input + summary.output)} tokens` : '—';
    $('usage-cost').title = summary.priced ? `$${summary.cost.toFixed(8)}` : '—';
    if (helpButton) showHelp(helpButton);
    for (const item of document.querySelectorAll<HTMLElement>('[data-usage-metric]')) item.setAttribute('aria-pressed', String(item.dataset.usageMetric === metric));
    const plot = $('usage-chart'); plot.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 600 170'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', t('usageTrend'));
    const values = data.daily.map(day => metric === 'cache' ? day.cacheInput ? 100 * day.cached / day.cacheInput : 0 : metric === 'cost' ? day.cost : metric === 'tokens' ? day.input + day.output : day.requests);
    const max = metric === 'cache' ? 100 : Math.max(metric === 'cost' ? .000001 : 1, ...values);
    const left = metric === 'cost' ? 90 : 48, chartWidth = 590 - left;
    const node = (tag: string, attrs: Record<string, string | number>, text?: string) => { const el = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); if (text !== undefined) el.textContent = text; svg.append(el); return el; };
    for (const fraction of [0, .5, 1]) {
      const y = 135 - fraction * 120;
      node('line', { x1: left, x2: 590, y1: y, y2: y, class: 'usage-grid' });
      node('text', { x: left - 8, y: y + 3, 'text-anchor': 'end', class: 'usage-axis' }, metric === 'cache' ? `${fraction * 100}%` : metric === 'cost' ? max * fraction >= 1000 ? '$' + compact(max * fraction) : money(max * fraction) : compact(max * fraction));
    }
    const width = chartWidth / values.length;
    values.forEach((value, i) => {
      const height = value / max * 120, day = data.daily[i];
      const bar = node('rect', { x: left + i * width + width * .2, y: 135 - height, width: width * .6, height, rx: 3, class: 'usage-bar' });
      const title = document.createElementNS(ns, 'title'); title.textContent = `${day.date} · ${metric === 'cache' ? percent(day.cached, day.cacheInput) : metric === 'cost' ? money(value) : integer(value)}`; bar.append(title);
      if (values.length <= 7 || i % 5 === 0 || i === values.length - 1) node('text', { x: left + (i + .5) * width, y: 158, 'text-anchor': 'middle', class: 'usage-axis' }, day.date.slice(5).replace('-', '/'));
    });
    plot.append(svg);
    const logs = filter.group === 'requests';
    document.querySelector('.usage-table').classList.toggle('usage-log', logs);
    $('usage-pagination').hidden = !logs || data.pages <= 1;
    $('usage-page-number').textContent = `${data.page + 1} / ${data.pages}`;
    $<HTMLButtonElement>('usage-prev').disabled = !data.page; $<HTMLButtonElement>('usage-next').disabled = data.page + 1 >= data.pages;
    const head = $('usage-table-head'), body = $('usage-table-body'); head.replaceChildren(); body.replaceChildren();
    const selected = selectedColumns();
    const labels = logs ? selected.map(([, key]) => key) : [filter.group === 'models' ? 'usageModel' : 'usageProvider', 'usageRequests', 'usageTokens', 'usageCost', 'usageSuccess', 'usageSpeed', 'usageFirstToken'];
    labels.forEach((key, i) => { const th = element('th', key === 'usageCost' ? t('usageCostShort') : t(key));
      if (['usageTokens', 'usageCost', 'usageSuccess', 'usageSpeed', 'usageFirstToken'].includes(key)) th.title = t(key + 'Help');
      if (logs ? !['time', 'app', 'provider', 'model'].includes(selected[i][0]) : i > 0) th.className = 'usage-number'; head.append(th); });
    for (const row of data.rows) {
      const tr = element('tr');
      if (logs && 'at' in row) {
        const known = row.total !== null, session = row.source === 'session';
        const date = new Date(row.at), today = date.toDateString() === new Date().toDateString();
        const statusKey = row.outcome === 'success' ? 'usageOK' : row.outcome === 'cancelled' ? 'usageCancelled' : row.outcome === 'unknown' ? 'usageUnknown' : 'usageFailed';
        const values = {
          time: date.toLocaleString(language(), { ...(today ? {} : { month: '2-digit' as const, day: '2-digit' as const }), hour: '2-digit', minute: '2-digit', ...(today ? { second: '2-digit' as const } : {}), hour12: false }),
          app: row.client === 'claude' ? 'Claude' : 'Codex', provider: session ? t('usageSessionProvider') : row.provider,
          model: row.model || t(row.image ? 'usageImageGeneration' : 'usageUnknownModel'), cost: row.cost === null ? '—' : money(row.cost),
          input: known ? compact(Math.max(0, row.input - (row.cached || 0) - (row.cacheWrite || 0))) : '—',
          output: row.output == null ? '—' : compact(row.output), cached: row.cached == null ? '—' : compact(row.cached), cacheWrite: row.cacheWrite == null ? '—' : compact(row.cacheWrite),
          speed: row.outcome === 'success' && row.firstTokenMs != null && row.output ? `${(1000 * row.output / Math.max(1, row.durationMs - row.firstTokenMs)).toFixed(1)} tok/s` : '—',
          firstToken: row.firstTokenMs == null ? '—' : `${(row.firstTokenMs / 1000).toFixed(1)}s`, duration: session ? '—' : `${(row.durationMs / 1000).toFixed(1)}s`, status: session ? '—' : `${row.status} · ${t(statusKey)}`,
        };
        for (const [id] of selected) {
          const td = element('td', values[id]); td.title = values[id];
          if (!['time', 'app', 'provider', 'model'].includes(id)) td.className = 'usage-number';
          if (id === 'time') td.title = date.toLocaleString(language());
          if (id === 'model') td.className = 'usage-model-name';
          if (id === 'app') { const content = element('span', undefined, 'usage-app'), icon = element('span', undefined, `client-logo ${row.client}-logo`); icon.setAttribute('aria-hidden', 'true'); content.append(icon, element('span', values.app)); td.replaceChildren(content); }
          if (id === 'status') td.title = session ? t('usageSessionUnknown') : `HTTP ${row.status} · ${t(statusKey + 'Help')}`;
          if (['input', 'output', 'cached', 'cacheWrite'].includes(id) && known) td.title = integer(id === 'input' ? Math.max(0, row.input - (row.cached || 0) - (row.cacheWrite || 0)) : row[id] || 0) + ' tokens';
          tr.append(td);
        }
      } else if ('requests' in row) {
        const client = row.client === 'claude' ? 'Claude Code' : 'Codex';
        const label = filter.group === 'models' ? row.model || t(row.image ? 'usageImageGeneration' : 'usageUnknownModel')
          : `${row.provider || t('usageSessionProvider')} · ${client}`;
        const cells = [label, integer(row.requests), row.reported ? compact(row.input + row.output) : '—', row.priced ? money(row.cost) : '—', percent(row.success, row.requests - row.unknown), row.generationMs ? `${(1000 * row.generatedOutput / row.generationMs).toFixed(1)} tok/s` : '—', row.timed ? `${(row.firstTokenMs / row.timed / 1000).toFixed(1)}s` : '—'];
        cells.forEach((value, i) => { const td = element('td', value, i === 0 ? 'usage-model-name' : 'usage-number'); td.title = value; tr.append(td); });
      }
      body.append(tr);
    }
    $('usage-empty').hidden = !!data.rows.length;
  }
  async function refresh() {
    clearTimeout(timer); if (!visible()) return; if (busy) { pending = true; request++; return; }
    busy = true; const id = ++request; $('usage-error').hidden = true; $<HTMLButtonElement>('usage-refresh').disabled = true;
    try { const next = await call('usage-stats', { ...filter, offsetMinutes: new Date().getTimezoneOffset() }); if (id === request) { data = next; render(); if (data.truncated) error(t('usageTruncated')); } }
    catch (value) { if (id === request) error(value); }
    finally { busy = false; $<HTMLButtonElement>('usage-refresh').disabled = false; if (visible()) { if (pending) { pending = false; void refresh(); } else timer = setTimeout(refresh, 60000); } }
  }
  $('usage-status').addEventListener('change', () => { filter.status = Number($<HTMLSelectElement>('usage-status').value) || undefined; filter.page = 0; refresh(); });
  $('usage-refresh').addEventListener('click', refresh);
  $('usage-range').addEventListener('change', () => { filter.days = Number($<HTMLSelectElement>('usage-range').value); filter.page = 0; refresh(); });
  for (const item of document.querySelectorAll<HTMLElement>('[data-usage-client]')) item.addEventListener('click', () => { filter.client = item.dataset.usageClient as UsageFilter['client']; filter.page = 0; for (const button of document.querySelectorAll<HTMLElement>('[data-usage-client]')) button.setAttribute('aria-pressed', String(button === item)); refresh(); });
  for (const item of document.querySelectorAll<HTMLElement>('[data-usage-group]')) item.addEventListener('click', () => { filter.group = item.dataset.usageGroup as UsageFilter['group']; filter.page = 0; for (const button of document.querySelectorAll<HTMLElement>('[data-usage-group]')) button.setAttribute('aria-selected', String(button === item)); refresh(); });
  for (const item of document.querySelectorAll<HTMLElement>('[data-usage-metric]')) item.addEventListener('click', () => { metric = item.dataset.usageMetric; render(); });
  for (const [id, step] of [['usage-prev', -1], ['usage-next', 1]] as const) $(id).addEventListener('click', () => { filter.page += step; refresh(); });
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (visible()) refresh(); });
  return { open() { $('settings-overview').hidden = true; $('usage-page').hidden = false; refresh(); }, close() { $('usage-page').hidden = true; hideHelp(); clearTimeout(timer); request++; }, localize() { if (visible()) render(); } };
}
