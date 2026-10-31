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
export class SessionTracker {
  constructor() { this.entries = new Map(); }
  begin(headers, payload) {
    const id = sessionID(headers);
    if (!id) return null;
    let metadata;
    try { metadata = JSON.parse(headers['x-codex-turn-metadata']); } catch {}
    if (metadata?.thread_id !== id && metadata?.session_id !== id) metadata = null;
    // Auxiliary requests still use the session's model but never create a task.
    if (metadata?.request_kind && metadata.request_kind !== 'turn') return { id, used() {}, finish() {} };
    let entry = this.entries.get(id);
    if (!entry) { entry = { id, activeRequests: 0, firstSeen: Date.now() }; this.entries.set(id, entry); }
    Object.assign(entry, { lastSeen: Date.now(), requestStartedAt: Date.now(), turnId: validID(metadata?.turn_id) ? metadata.turn_id : null, clientModel: payload.model, clientEffort: payload.reasoning?.effort || null });
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
