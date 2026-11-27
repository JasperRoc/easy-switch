export interface ModelEntry {
  id: string;
  label: string;
}

export interface ModelContext {
  window?: number;
  compact?: number;
}
export type ModelContexts = Record<string, ModelContext>;

const modelID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

export function modelContexts(value: unknown, claude: boolean): ModelContexts {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 256)
    throw new Error('Invalid model context settings.');
  const entries = [];
  for (const [id, context] of Object.entries(value)) {
    if (!modelID.test(id) || !context || typeof context !== 'object' || Array.isArray(context))
      throw new Error('Invalid model context settings.');
    const { window, compact } = context;
    if ((window !== undefined && (claude || !Number.isSafeInteger(window) || window < 1)) ||
        (compact !== undefined && (!Number.isSafeInteger(compact) || compact < (claude ? 100000 : 1))))
      throw new Error(claude ? 'Enter a Claude Code auto-compaction window of at least 100,000 tokens.' : 'Enter a positive whole number of tokens, or leave the field blank.');
    if (window !== undefined && compact !== undefined && compact >= window)
      throw new Error('The auto-compaction threshold must be lower than the context window.');
    if (window !== undefined || compact !== undefined) entries.push([id, { window, compact }]);
  }
  return Object.fromEntries(entries);
}

export function modelCatalog(value: unknown): ModelEntry[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error('A model catalog must contain at most 256 models.');
  const seen = new Set();
  return value.map(entry => {
    const id = entry?.id, label = typeof entry?.label === 'string' ? entry.label.trim() || id : entry?.label ?? id;
    if (typeof id !== 'string' || !modelID.test(id) ||
        typeof label !== 'string' || label.length > 120 || /[\x00-\x1f]/.test(label) || seen.has(id))
      throw new Error('Enter unique model IDs and display names of at most 120 characters.');
    seen.add(id);
    return { id, label };
  });
}

export function providerModels<T extends ModelEntry = ModelEntry>(provider: { modelCatalog?: ModelEntry[] }, discovered: T[] = []) {
  if (!Array.isArray(provider.modelCatalog)) return discovered;
  return provider.modelCatalog.map(entry => ({ ...discovered.find(model => model.id === entry.id), ...entry }));
}
