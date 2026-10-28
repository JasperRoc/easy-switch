export const messages = {
  en: {
    tagline: 'Keep every conversation flowing.', currentProvider: 'CURRENT PROVIDER', currentModel: 'MODEL & EFFORT',
    starting: 'Starting…', routingActive: 'Routing active', routingStopped: 'Routing stopped', startRouting: 'Start routing', stopRouting: 'Stop routing',
    providers: 'Providers', modelTab: 'Model & effort', networkTab: 'Network', language: 'Language', appearance: 'Appearance',
    systemTheme: 'System', lightTheme: 'Light', darkTheme: 'Dark', yourProviders: 'Your providers', priorityHelp: 'Top to bottom: automatic fallback priority.',
    addProvider: 'Add provider', empty: 'Add your first account or API. Keep your next conversation moving.',
    account: 'ChatGPT subscription', api: 'Official / third-party API', active: 'Active', selected: 'Selected', use: 'Use', signIn: 'Sign in',
    moveUp: 'Move {alias} up', moveDown: 'Move {alias} down', lastFailover: 'Last automatic switch: {from} → {to} (HTTP {status})',
    openLogin: 'Open official sign-in', chooseModel: 'A little more room to think.', modelHelp: 'Your next model request uses the new selection, including tool continuations.',
    refreshCatalog: 'Refresh catalog', loadCatalog: 'Load the catalog to choose a model.', model: 'Model', effort: 'Reasoning effort',
    followCodex: 'Follow Codex', providerDefault: 'Provider default', apply: 'Apply selection',
    modelLimits: 'Shared across sessions using this service. Codex’s own model indicator and capabilities stay as configured. Model access depends on your provider.',
    catalogLoading: 'Reading the model catalog…', catalogFailed: 'Could not load the catalog. Check the provider and network settings.',
    catalogChanged: 'Provider changed. Refresh the catalog before applying a selection.',
    internet: 'Your connection, your way.', internetHelp: 'Optional HTTP/HTTPS proxy for provider access. Local connections always bypass it.',
    proxyURL: 'Proxy URL', bypass: 'Bypass hosts', saveNetwork: 'Save & restart routing',
    networkLimits: 'Use an HTTP or mixed proxy port. Saving restarts routing and interrupts active requests. SOCKS-only URLs are not supported.',
    lifetime: 'Runs quietly in your tray. Quit to restore your original Codex connection. Open clients may need a restart or reload when routing starts or stops.',
    autoStart: 'Start at login', updates: 'Downloads & updates', quit: 'Quit easy-switch', close: 'Close', alias: 'Alias', aliasHint: 'personal or work',
    type: 'Provider type', baseURL: 'Base URL', baseHint: 'Blank = official OpenAI API', apiKey: 'API key',
    accountHelp: 'Sign in on the official ChatGPT device page, or import an existing file-based Codex sign-in. Credentials stay on this computer.',
    addAPI: 'Add API provider', signInChatGPT: 'Sign in with ChatGPT', importLogin: 'Import Codex sign-in',
    startingLogin: 'Preparing official device sign-in…', phaseStarting: 'Preparing', phasePending: 'Waiting for sign-in', phaseComplete: 'Signed in', phaseFailed: 'Sign-in failed',
    restartConfirm: 'Restart routing and interrupt active requests?', stopConfirm: 'Stop routing and interrupt active requests?',
    trayActive: 'Active · {alias}', noProvider: 'No provider', trayStopped: 'Routing is stopped', traySettings: 'Providers & settings…', trayModel: 'Model & effort…',
    notifyTitle: 'Provider switched automatically', loginNeeded: 'Sign-in needed', keepRunning: 'Keep running', quitShort: 'Quit',
    requestsRunning: 'Codex requests are still running.', quitDetail: 'Quitting interrupts them and restores your original Codex connection. Open clients may need a restart or reload.',
    loginPermission: 'The operating system did not apply the login startup setting. Check login-item permissions in system settings.',
  },
  'zh-CN': {
    tagline: '让每一次对话，自然延续。', currentProvider: '当前服务商', currentModel: '模型与推理强度',
    starting: '正在启动…', routingActive: '路由已启用', routingStopped: '路由已停止', startRouting: '启用路由', stopRouting: '停止路由',
    providers: '服务商', modelTab: '模型与推理', networkTab: '网络', language: '语言', appearance: '外观',
    systemTheme: '跟随系统', lightTheme: '浅色', darkTheme: '深色', yourProviders: '你的服务商', priorityHelp: '从上到下，依次为自动切换的备用顺序。',
    addProvider: '添加服务商', empty: '添加你的第一个订阅账号或 API，让下一次对话流畅开始。',
    account: 'ChatGPT 订阅账号', api: '官方 / 第三方 API', active: '使用中', selected: '已选择', use: '切换', signIn: '登录',
    moveUp: '上移 {alias}', moveDown: '下移 {alias}', lastFailover: '上次自动切换：{from} → {to}（HTTP {status}）',
    openLogin: '打开官方认证页面', chooseModel: '为思考，留一点余地。', modelHelp: '下一次模型请求生效，也包括任务中的工具调用续接。',
    refreshCatalog: '刷新模型目录', loadCatalog: '加载目录，选择模型。', model: '模型', effort: '推理强度（effort）',
    followCodex: '跟随 Codex', providerDefault: '服务商默认', apply: '应用设置',
    modelLimits: '对本服务下的所有会话生效；Codex 原生模型标签及客户端能力保持原设置，模型访问权限由服务商决定。',
    catalogLoading: '正在读取模型目录…', catalogFailed: '无法加载目录，请检查服务商和网络设置。',
    catalogChanged: '服务商已变化，请刷新目录后再应用设置。',
    internet: '连接方式，由你选择。', internetHelp: '可选的 HTTP/HTTPS 外网代理，本机连接始终绕过代理。',
    proxyURL: '代理地址', bypass: '直连主机', saveNetwork: '保存并重启路由',
    networkLimits: '请使用 HTTP 或混合代理端口。保存会重启路由并中断当前请求；暂不支持纯 SOCKS 地址。',
    lifetime: '安静驻留于托盘。退出软件会恢复原 Codex 连接；路由启停后，已打开的客户端可能需要重启或重载。',
    autoStart: '开机自启动', updates: '下载与更新', quit: '退出 easy-switch', close: '关闭', alias: '别名', aliasHint: '如 personal 或 work',
    type: '服务商类型', baseURL: 'Base URL', baseHint: '留空使用 OpenAI 官方 API', apiKey: 'API 密钥',
    accountHelp: '通过 ChatGPT 官方设备认证页面登录，或导入 Codex 已有的文件式登录凭据。凭据保存在本机。',
    addAPI: '添加 API 服务商', signInChatGPT: '使用 ChatGPT 登录', importLogin: '导入 Codex 登录',
    startingLogin: '正在准备官方设备认证…', phaseStarting: '准备中', phasePending: '等待认证', phaseComplete: '已登录', phaseFailed: '认证失败',
    restartConfirm: '重启路由并中断当前请求？', stopConfirm: '停止路由并中断当前请求？',
    trayActive: '当前 · {alias}', noProvider: '未添加服务商', trayStopped: '路由已停止', traySettings: '服务商与设置…', trayModel: '模型与推理强度…',
    notifyTitle: '已自动切换服务商', loginNeeded: '需要登录', keepRunning: '继续运行', quitShort: '退出',
    requestsRunning: 'Codex 仍有正在进行的请求。', quitDetail: '退出会中断这些请求并恢复原 Codex 连接。已打开的客户端可能需要重启或重载。',
    loginPermission: '系统未应用自启动设置，请在系统设置中检查登录项权限。',
  },
};
export function normalizeLanguage(value = 'en') { return String(value).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'; }
export function translate(language, key, values = {}) {
  const text = messages[normalizeLanguage(language)][key] ?? messages.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}
const notices = [
  ['目录来自 Codex CLI；实际可用性以当前账号权限为准。', 'Catalog provided by Codex CLI; availability depends on your account.'],
  ['仅列出服务商目录与 Codex 目录共同识别的模型。', 'Showing models recognized by both your provider and Codex.'],
  ['无法读取服务商 /models，显示 Codex 目录；请确认所选模型受该服务商支持。', 'Provider /models is unavailable. Showing the Codex catalog; confirm your provider supports your selection.'],
  ['正在准备官方设备认证…', 'Preparing official device sign-in…'],
  ['认证已完成，请重试请求。', 'Authentication complete. Retry your request.'],
  ['认证超时，请重试以重新开始。', 'Authentication timed out. Retry your request to start again.'],
  ['认证失败，请在 ChatGPT 设置中启用设备代码登录后重试。', 'Authentication failed. Enable device code login in your ChatGPT settings, then retry.'],
  ['认证未恢复同一个账号，原凭据已保留。请重试登录。', 'Authentication did not restore the same account. Original credentials were preserved. Retry to sign in again.'],
  ['无法启动认证，请检查内置 Codex 程序。', 'Unable to start authentication. Check that the service can run Codex CLI.'],
  ['认证已取消。', 'Authentication cancelled.'],
  ['请输入有效的 API 密钥。', 'Enter a valid API key.'],
  ['请先完成当前登录。', 'Finish the current sign-in first.'],
  ['此别名已用于 API 服务商。', 'That alias belongs to an API provider.'],
  ['请刷新模型目录并选择支持的推理强度。', 'Reload the model catalog and choose a supported effort.'],
  ['请先添加服务商。', 'Add a provider first.'],
];
export function localizeMessage(value, language) {
  const text = String(value || '');
  const match = notices.find(pair => pair.includes(text));
  if (match) return match[normalizeLanguage(language) === 'zh-CN' ? 0 : 1];
  if (normalizeLanguage(language) === 'zh-CN' && text.startsWith('Account authentication required. Open ')) return '请打开官方认证页面并输入下方验证码，登录同一账号后重试请求。';
  return text;
}
