const validID = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

export function sessionID(headers) {
  const thread = headers['thread-id'], session = headers['session-id'];
  if (thread && session && thread !== session) return null;
  const id = thread || session;
  return validID(id) ? id : null;
}
export function selectedModel(state, id) {
  return id && Object.hasOwn(state.sessionModels || {}, id) ? state.sessionModels[id] : state.modelSelection || null;
}
function requestTitle(input) {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim().slice(0, 100);
  for (const item of [...input].reverse()) {
    if (item.role !== 'user') continue;
    let text = typeof item.content === 'string' ? item.content : (item.content || []).filter(part => part.type === 'input_text').map(part => part.text || '').join(' ');
    if (text.includes('## My request:')) text = text.split('## My request:').at(-1);
    if (/^\s*(?:<environment_context>|# AGENTS\.md|<user_instructions>)/.test(text)) continue;
    text = text.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 100);
  }
  return '';
}
export class SessionTracker {
  constructor() { this.entries = new Map(); }
  begin(headers, payload) {
    const id = sessionID(headers);
    if (!id) return null;
    let entry = this.entries.get(id);
    if (!entry) { entry = { id, activeRequests: 0 }; this.entries.set(id, entry); }
    Object.assign(entry, { title: requestTitle(payload.input) || entry.title || '', lastSeen: Date.now(), clientModel: payload.model, clientEffort: payload.reasoning?.effort || null });
    entry.activeRequests++;
    let finished = false;
    return { id, used: (alias, payload) => Object.assign(entry, { provider: alias, model: payload.model, effort: payload.reasoning?.effort || null }),
      finish: () => { if (!finished) { finished = true; entry.activeRequests--; entry.lastSeen = Date.now(); } } };
  }
  snapshot(state) {
    return [...this.entries.values()].sort((a, b) => Number(b.activeRequests > 0) - Number(a.activeRequests > 0) || b.lastSeen - a.lastSeen)
      .map(entry => ({ ...entry, overridden: Object.hasOwn(state.sessionModels || {}, entry.id), selection: selectedModel(state, entry.id) }));
  }
}
