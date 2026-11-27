// Official USD per million tokens, verified 2026-11-25. Updated with releases.
// Sources and reference-price limitations: docs/desktop.md#official-reference-prices
// Tuple: fresh input, output, cache read, short cache write, long cache write.
type Rate = readonly [number, number, number | null, number | null, number | null];
const openai: Record<string, Rate> = {
  'gpt-6.2-astra': [8.00, 40.00, 0.40, 10.00, 20.00],
  'gpt-6.2-sol': [2.00, 10.00, 0.10, 2.50, 5.00],
  'gpt-6-astra': [10.00, 50.00, 1.00, 12.50, 25.00],
  'gpt-6.1-sol': [2.00, 10.00, 0.10, 2.50, 5.00],
  'gpt-6.1-terra': [1.00, 5.00, 0.05, 1.25, 2.50],
  'gpt-6-luna': [0.10, 0.50, 0.01, 0.125, 0.25],
  'gpt-6-sol': [2.00, 10.00, 0.20, 2.50, 5.00],
  'gpt-5.6-sol': [4.00, 20.00, 0.40, 5.00, 10.00],
  'gpt-5.6-terra': [2.00, 12.00, 0.20, 2.50, 5.00],
  'gpt-5.6-luna': [0.20, 1.20, 0.02, 0.25, 0.50],
  'gpt-5.5': [5.00, 30.00, 0.50, null, null],
  'gpt-5.5-pro': [30.00, 180.00, null, null, null],
  'gpt-5.4': [2.50, 15.00, 0.25, null, null],
  'gpt-5.4-pro': [30.00, 180.00, null, null, null],
  'gpt-5.4-mini': [0.75, 4.50, 0.075, null, null],
  'gpt-5.4-nano': [0.20, 1.25, 0.02, null, null],
  'gpt-5.2': [1.75, 14.00, 0.175, null, null],
  'gpt-5.2-pro': [21.00, 168.00, null, null, null],
  'gpt-5.1': [1.25, 10.00, 0.125, null, null],
  'gpt-5': [1.25, 10.00, 0.125, null, null],
  'gpt-5-mini': [0.25, 2.00, 0.025, null, null],
  'gpt-5-nano': [0.05, 0.40, 0.005, null, null],
  'gpt-5-pro': [15.00, 120.00, null, null, null],
  'gpt-4.1': [2.00, 8.00, 0.50, null, null],
  'gpt-4.1-mini': [0.40, 1.60, 0.10, null, null],
  'gpt-4o': [2.50, 10.00, 1.25, null, null],
  'gpt-4o-mini': [0.15, 0.60, 0.075, null, null],
  'o3-pro': [20.00, 80.00, null, null, null],
  'o3': [2.00, 8.00, 0.50, null, null],
  'gpt-5.3-codex': [1.75, 14, .175, null, null],
};
const longOpenAI = new Set(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro']);
// Anthropic short/long cache writes are 5 minutes / 1 hour.
const claude: Record<string, Rate> = {
  'claude-fable-5-2': [8, 40, .2, 10, 16],
  'claude-mythos-5-2': [8, 40, .2, 10, 16],
  'claude-fable-5-1': [10, 50, .25, 12.5, 20],
  'claude-mythos-5-1': [10, 50, .25, 12.5, 20],
  'claude-fable-5': [10, 50, 1, 12.5, 20],
  'claude-mythos-5': [10, 50, 1, 12.5, 20],
  'claude-opus-5-5': [4, 20, .2, 5, 8],
  'claude-opus-5': [5, 25, .5, 6.25, 10],
  'claude-opus-4-8': [5, 25, .5, 6.25, 10],
  'claude-opus-4-7': [5, 25, .5, 6.25, 10],
  'claude-opus-4-6': [5, 25, .5, 6.25, 10],
  'claude-opus-4-5': [5, 25, .5, 6.25, 10],
  'claude-opus-4-1': [15, 75, 1.5, 18.75, 30],
  'claude-opus-4': [15, 75, 1.5, 18.75, 30],
  'claude-sonnet-5-5': [2, 10, .1, 2.5, 4],
  'claude-sonnet-5': [2, 10, .2, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, .3, 3.75, 6],
  'claude-sonnet-4-5': [3, 15, .3, 3.75, 6],
  'claude-sonnet-4': [3, 15, .3, 3.75, 6],
  'claude-haiku-5-5': [.1, .5, .01, .125, .2],
  'claude-haiku-4-5': [1, 5, .1, 1.25, 2],
};
// Peak list rates are the reference; time discounts are not invoice estimates.
const deepseek: Record<string, Rate> = {
  'deepseek-v4-pro': [1.32, 3.96, .044, null, null],
  'deepseek-flash': [.3, 1.2, .006, null, null],
  'deepseek-v4-flash': [.3, 1.2, .006, null, null],
  'deepseek-v4-flash-vision-exp': [.3, 1.2, .006, null, null],
};
export function officialTokenCost(model: string, input: number, output: number, cached = 0, cacheWrite = 0, cacheWriteLong = 0): number | null {
  const claudeID = model.replace(/-\d{8}$/, '');
  let rate = Object.hasOwn(openai, model) ? openai[model] : Object.hasOwn(claude, claudeID) ? claude[claudeID] : Object.hasOwn(deepseek, model) ? deepseek[model] : undefined;
  if (!rate || cached + cacheWrite > input || cacheWriteLong > cacheWrite) return null;
  if (input > 272000 && longOpenAI.has(model)) rate = [rate[0] * 2, rate[1] * 1.5, rate[2] === null ? null : rate[2] * 2, rate[3] === null ? null : rate[3] * 2, rate[4] === null ? null : rate[4] * 2];
  if (claudeID === 'claude-haiku-5-5' && input > 100000) rate = [.5, 2.5, .05, .625, 1];
  if (['claude-sonnet-4', 'claude-sonnet-4-5'].includes(claudeID) && input > 200000) return null;
  const tokens = [input - cached - cacheWrite, output, cached, cacheWrite - cacheWriteLong, cacheWriteLong];
  if (tokens.some((value, index) => value > 0 && rate[index] === null)) return null;
  return tokens.reduce((cost, value, index) => cost + value * (rate[index] || 0), 0) / 1000000;
}
