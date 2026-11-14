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
