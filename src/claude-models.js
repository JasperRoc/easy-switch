export function claudeModelMapping(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['default', 'subagent'].includes(key))) throw new Error('Invalid Claude model mapping.');
  const result = {};
  for (const key of ['default', 'subagent']) {
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
  if (headers['x-claude-code-agent-id']) return mapping.subagent || mapping.default || model;
  if (/^(?:claude-|sonnet(?:\[1m\])?$|opus(?:\[1m\])?$|haiku$|fable$)/i.test(model || '')) {
    return /haiku/i.test(model) ? mapping.subagent || mapping.default || model : mapping.default || model;
  }
  return model;
}

export function claudeModelEnvironment(provider) {
  const model = provider?.type === 'api' && provider.claudeModels?.default;
  return model ? { ANTHROPIC_CUSTOM_MODEL_OPTION: model, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: model } : {};
}
