import { init, setModel } from './store.js';
import { discoverModels } from './catalog.js';
import { select } from './select.js';

export async function chooseModel(root, { discoverImpl = discoverModels, selectImpl = select } = {}) {
  const state = init(root);
  const provider = state.providers[state.active];
  if (!provider) throw new Error('请先添加并选择账号/API');
  const { models, notice } = await discoverImpl(provider, root);
  const labels = ['跟随 Codex（取消模型与 effort 覆盖）', ...models.map(model => `${model.label} (${model.id})`)];
  const initial = models.findIndex(model => model.id === state.modelSelection?.model) + 1;
  const index = await selectImpl(`选择模型 · 当前上游 ${state.active}`, labels, { initial, subtitle: notice });
  if (index === null) return { cancelled: true };
  if (index === 0) { setModel(null, root, state.active); return { selection: null, notice }; }
  const model = models[index - 1];
  const effortIndex = await selectImpl(`选择 ${model.id} 的推理强度`, ['服务商默认', ...model.efforts], {
    initial: model.efforts.indexOf(state.modelSelection?.model === model.id ? state.modelSelection.effort : model.defaultEffort) + 1,
  });
  if (effortIndex === null) return { cancelled: true };
  const selection = { model: model.id, effort: effortIndex === 0 ? null : model.efforts[effortIndex - 1] };
  setModel(selection, root, state.active);
  return { selection, notice };
}

export function applyModel(payload, selection) {
  if (!selection) return payload;
  const result = { ...payload, model: selection.model };
  if (selection.effort !== null) result.reasoning = { ...payload.reasoning, effort: selection.effort };
  else if (payload.reasoning) {
    result.reasoning = { ...payload.reasoning };
    delete result.reasoning.effort;
    if (!Object.keys(result.reasoning).length) delete result.reasoning;
  }
  return result;
}
