// Port of the pre-response failover policy in cxl3's codex-switch hot_proxy.py/auto.py.
import { accountAuth, providerOrder } from './store.js';
import { expired } from './auth.js';

export function recoverable(status, message = '') {
  try {
    const data = JSON.parse(message), failure = data.response?.error || data.error || data;
    message = typeof failure === 'string' ? failure : [failure.code, failure.type, failure.message, data.detail].filter(value => typeof value === 'string').join(' ');
  } catch {}
  if (/content[_ -]?(?:policy|filter)|safety|moderation|refusal|refused|unsupported_country|(?:country|region|territory).*(?:not supported|not allowed)|(?:organization|workspace|admin|security) policy|内容安全|内容政策|地区.{0,20}不支持/i.test(message)) return false;
  if ([401, 402, 429].includes(status)) return true;
  return status === 403;
}
export function rejectionStatus(error) {
  const status = Number(error?.status || error?.status_code);
  if ([401, 402, 403, 429, 500, 502, 503, 504, 529].includes(status)) return status;
  const statuses = { __proto__: null, authentication_error: 401, invalid_api_key: 401, permission_error: 403, forbidden: 403, access_denied: 403, rate_limit_error: 429,
    server_error: 500, internal_server_error: 500, service_unavailable: 503 };
  return statuses[error?.code] || statuses[error?.type];
}
export function modelUnavailable(status, message = '') {
  if (![400, 403, 404, 422].includes(status)) return false;
  try {
    const data = JSON.parse(message), failure = data.response?.error || data.error || data;
    message = [failure.code, failure.type, failure.message, data.detail].filter(value => typeof value === 'string').join(' ');
  } catch {}
  if (/policy|safety|moderation|content_filter|refusal/i.test(message)) return false;
  return /\b(?:model_not_found|model_not_supported|unsupported_model|model_access_denied|model_permission_denied|model_not_available)\b/i.test(message)
    || /\bmodel\b.{0,160}\b(?:does not exist|not found|not (?:supported|available|accessible|enabled|allowed|permitted)|access denied|permission denied)\b/i.test(message)
    || /\b(?:do not|don't|does not|doesn't) have access to (?:the )?(?:requested )?model\b/i.test(message)
    || /\bnot (?:allowed|authorized|permitted) to (?:access|use) (?:the )?(?:requested )?model\b/i.test(message)
    || /模型.{0,100}(?:不(?:支持|存在|可用)|无(?:权限|访问权限))|(?:无权|无权限|没有权限|不支持).{0,50}模型/.test(message);
}
export function atCapacity(message = '') {
  try {
    const data = JSON.parse(message);
    const failure = data.response?.error || data.error || data;
    message = [failure.code, failure.type, failure.message, data.detail].filter(value => typeof value === 'string').join(' ');
  } catch {}
  return /\b(?:overloaded_error|server_overloaded|model_overloaded|model_at_capacity)\b|\b(?:selected |requested )?model is at capacity\b|\b(?:server|model) (?:is )?(?:currently )?overloaded\b|\bflex capacity unavailable\b/i.test(message);
}
export function capacityDelay(header, retry, time = Date.now()) {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header || '') - time;
  return Math.max(1000 * 2 ** retry, Number.isFinite(seconds) ? seconds : 0);
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
export function alternate(state, failed, cooldown, now, attempted = new Set(), accepts = () => true) {
  return providerOrder(state).find(alias => alias !== failed && !attempted.has(alias) &&
    (cooldown.get(alias) || 0) <= now && accepts(state.providers[alias], alias) && usable(state.providers[alias]));
}
