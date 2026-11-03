// Account claims describe plan availability; the upstream still decides access.
export function imageEligible(auth) {
  for (const token of [auth.tokens?.id_token, auth.tokens?.access_token]) {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
      const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
      if (typeof plan === 'string') return plan.toLowerCase() !== 'free';
    } catch {}
  }
  return true; // Older credentials may not contain plan metadata.
}

export function imageUnavailable(status, message) {
  if (![400, 403, 404].includes(status)) return false;
  try {
    const data = JSON.parse(message), failure = data.response?.error || data.error || data;
    message = [failure.code, failure.type, failure.message].filter(value => typeof value === 'string').join(' ');
  } catch {}
  if (/policy|safety|moderation|content_filter|refusal/i.test(message)) return false;
  return /\b(?:image_generation_not_supported|image_generation_unavailable|unsupported_plan|plan_not_supported|feature_not_available|model_not_found)\b/i.test(message)
    || /\b(?:image generation|imagegen|gpt-image[\w.-]*)\b.*\b(?:not (?:available|supported|enabled|allowed)|requires? (?:a )?(?:paid|plus|pro)|upgrade|free plan)\b/i.test(message)
    || /\b(?:free plan|your plan|subscription)\b.*\b(?:does not support|not support|not (?:available|eligible|entitled))\b/i.test(message);
}
