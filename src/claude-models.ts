import type { Provider } from './store.js';

export const claudeFamilies = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type ClaudeFamily = typeof claudeFamilies[number];
export type ClaudeModelMapping = Partial<Record<ClaudeFamily | 'default' | 'subagent', string>>;

export function claudeModelFamily(model: unknown): ClaudeFamily | null {
  if (typeof model !== 'string') return null;
  const id = model.replace(/\[1m\]$/i, '').toLowerCase();
  const exact = claudeFamilies.find(family => family === id);
  if (exact) return exact;
  return /^claude-/.test(id) ? claudeFamilies.find(family => new RegExp(`(?:^|-)${family}(?:-|$)`).test(id)) || null : null;
}

export function claudeModelMapping(value: unknown): ClaudeModelMapping | null {
  if (value == null) return null;
  const keys = [...claudeFamilies, 'default', 'subagent'] as const;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.some(allowed => allowed === key))) throw new Error('Invalid Claude model mapping.');
  const result: ClaudeModelMapping = {};
  for (const key of keys) {
    const id: unknown = value[key];
    if (id == null || id === '') continue;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}(?:\[1m\])?$/.test(id)) throw new Error('Invalid Claude model mapping.');
    result[key] = id;
  }
  return Object.keys(result).length ? result : null;
}

export function mappedClaudeModel(provider: Pick<Provider, 'type' | 'claudeModels'>, model: string, headers: Readonly<Record<string, unknown>> = {}) {
  if (provider.type !== 'api' || !provider.claudeModels) return model;
  const mapping = provider.claudeModels;
  const family = claudeModelFamily(model);
  if (!family && !/^claude-/i.test(model || '')) return model;
  if (mapping[family]) return mapping[family];
  if (headers['x-claude-code-agent-id']) return mapping.subagent || mapping.default || model;
  return family === 'haiku' ? mapping.subagent || mapping.default || model : mapping.default || model;
}

export function claudeModelEnvironment(provider: Provider | undefined) {
  const model = provider?.type === 'api' && provider.claudeModels?.default;
  return { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: '30000',
    ...(model ? { ANTHROPIC_CUSTOM_MODEL_OPTION: model, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: model } : {}) };
}
