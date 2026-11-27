// Port of the pre-response failover policy in cxl3's fluid hot_proxy.py/auto.py.
import { accountAuth, providerOrder, type Provider, type ProviderState } from '../../src/store.js';
import { expired } from '../../src/auth.js';

export function recoverable(status: number, message = '') {
  try {
    const data = JSON.parse(message), failure = data.response?.error || data.error || data;
    message = typeof failure === 'string' ? failure : [failure.code, failure.type, failure.message, data.detail].filter(value => typeof value === 'string').join(' ');
  } catch {}
  if (/content[_ -]?(?:policy|filter)|safety|moderation|refusal|refused|unsupported_country|(?:country|region|territory).*(?:not supported|not allowed)|(?:organization|workspace|admin|security) policy|内容安全|内容政策|地区.{0,20}不支持/i.test(message)) return false;
  if ([401, 402, 429].includes(status)) return true;
  return status === 403 || status === 400 && !/\b(?:invalid_json|json_parse_error|malformed_json|missing_required_parameter|missing_required_field|context_length_exceeded|context_window_exceeded|input_too_long|max_tokens_exceeded)\b|\b(?:invalid|malformed) (?:json|request body)\b|\b(?:missing|required) (?:parameter|field|argument)\b|\b(?:parameter|field|argument)\b.{0,80}\b(?:is required|must be|must have|must contain)\b|\binvalid (?:parameter|argument|temperature|effort)\b|\bcontext (?:window|length)\b.{0,40}\b(?:exceed|too (?:long|large))|\b(?:maximum context length|too many tokens|input is too long)\b|上下文.{0,20}(?:超|过长)|(?:缺少|缺失|非法|无效).{0,12}(?:参数|字段)|(?:参数|字段).{0,12}(?:必填|不能为空|格式错误)/i.test(message);
}
export function rejectionStatus(error: unknown) {
  let failure;
  if (typeof error === 'string') { try { error = JSON.parse(error); } catch { error = { message: error }; } }
  if (error && typeof error === 'object') {
    const value = error as { response?: { error?: unknown }; error?: unknown };
    failure = value.response?.error || value.error || value;
  } else failure = error;
  const status = Number(failure?.status || failure?.status_code);
  if ([401, 402, 403, 429, 500, 502, 503, 504, 529].includes(status)) return status;
  const statuses = { __proto__: null, authentication_error: 401, invalid_api_key: 401, permission_error: 403, forbidden: 403, access_denied: 403, rate_limit_error: 429,
    rate_limit_exceeded: 429, rate_limit_reached: 429, usage_limit_reached: 429, insufficient_quota: 429,
    insufficient_credits: 402, insufficient_balance: 402, credits_exhausted: 402, billing_hard_limit_reached: 402,
    server_error: 500, internal_server_error: 500, service_unavailable: 503 };
  const known = statuses[failure?.code?.toLowerCase?.()] || statuses[failure?.type?.toLowerCase?.()];
  if (known) return known;
  const message = typeof failure === 'string' ? failure : failure?.message || '';
  if (/\b(?:usage|rate)[ _-]?limit (?:reached|exceeded)|\b(?:hit|reached|exceeded) (?:your |the )?(?:usage |rate )?limit\b|\b(?:quota|credits?|balance) (?:exhausted|depleted|exceeded)|\binsufficient (?:quota|credits?|balance)\b|额度.{0,20}(?:耗尽|用尽|用完|不足)|余额不足/i.test(message)) return 429;
}
export function modelUnavailable(status: number, message = '') {
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
export async function rejectionText(response: Response) {
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
function usable(provider: Provider) {
  if (provider.type === 'api') return !!(provider.apiKey && provider.baseUrl);
  if (provider.type !== 'account') return false;
  try { return !expired(accountAuth(provider)); } catch { return false; }
}
export function alternate(state: ProviderState, failed: string | null, cooldown: ReadonlyMap<string, number>, now: number, attempted = new Set<string>(), accepts: (provider: Provider, alias: string) => boolean = () => true) {
  return providerOrder(state).find(alias => alias !== failed && !attempted.has(alias) &&
    (cooldown.get(alias) || 0) <= now && accepts(state.providers[alias], alias) && usable(state.providers[alias]));
}
