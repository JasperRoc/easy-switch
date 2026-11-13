export const claudeFamilies = ['fable', 'opus', 'sonnet', 'haiku'];

export function claudeModelFamily(model) {
  if (typeof model !== 'string') return null;
  const id = model.replace(/\[1m\]$/i, '').toLowerCase();
  if (claudeFamilies.includes(id)) return id;
  return /^claude-/.test(id) ? claudeFamilies.find(family => new RegExp(`(?:^|-)${family}(?:-|$)`).test(id)) || null : null;
}

export function claudeModelMapping(value) {
  if (value == null) return null;
  const keys = [...claudeFamilies, 'default', 'subagent'];
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid Claude model mapping.');
  const result = {};
  for (const key of keys) {
    const id = value[key];
    if (id == null || id === '') continue;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}(?:\[1m\])?$/.test(id)) throw new Error('Invalid Claude model mapping.');
    result[key] = id;
  }
  return Object.keys(result).length ? result : null;
}

export function mappedClaudeModel(provider, model, headers = {}) {
  if (provider.type !== 'api' || !provider.claudeModels) return model;
  const mapping = provider.claudeModels;
  const family = claudeModelFamily(model);
  if (!family && !/^claude-/i.test(model || '')) return model;
  if (mapping[family]) return mapping[family];
  if (headers['x-claude-code-agent-id']) return mapping.subagent || mapping.default || model;
  return family === 'haiku' ? mapping.subagent || mapping.default || model : mapping.default || model;
}

export function claudeModelEnvironment(provider) {
  const model = provider?.type === 'api' && provider.claudeModels?.default;
  return { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: '30000',
    ...(model ? { ANTHROPIC_CUSTOM_MODEL_OPTION: model, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: model } : {}) };
}
