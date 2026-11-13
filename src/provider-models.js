export function modelCatalog(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error('A model catalog must contain at most 256 models.');
  const seen = new Set();
  return value.map(entry => {
    const id = entry?.id, label = typeof entry?.label === 'string' ? entry.label.trim() || id : entry?.label ?? id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id) ||
        typeof label !== 'string' || label.length > 120 || /[\x00-\x1f]/.test(label) || seen.has(id))
      throw new Error('Enter unique model IDs and display names of at most 120 characters.');
    seen.add(id);
    return { id, label };
  });
}

export function providerModels(provider, discovered = []) {
  if (!Array.isArray(provider.modelCatalog)) return discovered;
  return provider.modelCatalog.map(entry => ({ ...discovered.find(model => model.id === entry.id), ...entry }));
}
