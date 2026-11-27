// Account plan identifiers remain distinct; quota size is never used to guess a tier.
export function planLabel(plan, client = 'codex') {
  if (typeof plan !== 'string' || !plan.trim()) return null;
  const key = plan.trim().toLowerCase();
  if (key === 'unknown') return null;
  const labels = { free: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 100', pro: 'Pro 200', promax: 'Pro 500',
    team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro' };
  if (client === 'claude') return { free: 'Free', pro: 'Pro', max: 'Max', ultra: 'Ultra', team: 'Team', enterprise: 'Enterprise' }[key] || null;
  return labels[key] || key.split(/[_ -]+/).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function claudeSavedPlan(auth) {
  const plan = typeof auth?.subscriptionType === 'string' ? auth.subscriptionType.trim().toLowerCase() : null;
  if (!planLabel(plan, 'claude')) return null;
  const verified = auth.subscriptionTypeSource === 'profile' && Number.isFinite(auth.subscriptionTypeVerifiedAt);
  if (!verified && ['pro', 'max', 'ultra'].includes(plan) && auth.rateLimitTier === 'default_claude_ai') return null;
  return plan === 'max' && auth.rateLimitTier === 'default_claude_max_20x' ? 'ultra' : plan;
}

export function claudeProfilePlan(profile) {
  const organization = profile?.organization, account = profile?.account;
  const plan = { claude_free: 'free', claude_pro: 'pro', claude_max: 'max', claude_ultra: 'ultra', claude_team: 'team', claude_enterprise: 'enterprise' }[organization?.organization_type];
  if (['team', 'enterprise'].includes(plan)) return plan;
  if (account?.has_claude_max === true) return organization?.rate_limit_tier === 'default_claude_max_20x' ? 'ultra' : plan === 'ultra' ? 'ultra' : 'max';
  if (account?.has_claude_pro === true) return 'pro';
  if (account?.has_claude_pro === false && account.has_claude_max === false) return 'free';
  return claudeSavedPlan({ subscriptionType: plan, rateLimitTier: organization?.rate_limit_tier });
}
