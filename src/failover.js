// Port of the pre-response failover policy in cxl3's codex-switch hot_proxy.py/auto.py.
import { accountAuth, providerOrder } from './store.js';
import { expired } from './auth.js';

export function recoverable(status, message = '') {
  if ([401, 402, 429].includes(status)) return true;
  return status === 403 && /额度不足|余额不足|配额(?:不足|已耗尽)|insufficient[ _](?:quota|balance|credits)|quota (?:exceeded|exhausted)/i.test(message);
}
export async function rejectionText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (size < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 65536 - size);
      chunks.push(chunk); size += chunk.length;
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
function usable(provider) {
  if (provider.type === 'api') return !!(provider.apiKey && provider.baseUrl);
  if (provider.type !== 'account') return false;
  try { return !expired(accountAuth(provider)); } catch { return false; }
}
export function alternate(state, failed, cooldown, now, attempted = new Set()) {
  return providerOrder(state).find(alias => alias !== failed && !attempted.has(alias) &&
    (cooldown.get(alias) || 0) <= now && usable(state.providers[alias]));
}
