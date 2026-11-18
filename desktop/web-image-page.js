// These functions run in an isolated browser world against the official image UI.
// They use the page's own composer and never read tokens, cookies or page globals.
export function inspectImagePage() {
  const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  const editor = [...document.querySelectorAll('#prompt-textarea, #mobile-composer-prompt, [role="textbox"][contenteditable="true"]')].find(visible);
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  const stop = buttons.some(button => /stop-button/.test(button.getAttribute('data-testid') || '') || /^(Stop|Stop generating|Stop streaming|停止|停止生成|停止流式传输)$/i.test(button.getAttribute('aria-label') || ''));
  const login = buttons.some(button => /^(Log in|Sign in|登录)$/i.test((button.innerText || '').trim()));
  const verification = /verify you are human|checking your browser|just a moment|验证您是人类/i.test(document.title + '\n' + (document.body?.innerText || '').slice(0, 3000));
  const turns = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-response-body]')];
  const last = turns.at(-1)?.innerText || '';
  const alert = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(element => element.innerText).join('\n');
  const quotaNotices = buttons.filter(button => /升级以获取更多额度|upgrade.{0,30}(?:more|limits|images)/i.test(button.innerText || '')).map(button => button.parentElement?.innerText || '').join('\n');
  const composer = (editor?.closest('[data-dropdown-overlay-side]') || editor?.parentElement?.parentElement)?.cloneNode(true);
  for (const input of composer?.querySelectorAll('textarea, [contenteditable="true"]') || []) input.remove();
  const composerStatus = (composer?.textContent || '') + '\n' + quotaNotices;
  const quota = /image.{0,50}(?:limit|quota)|(?:limit|quota).{0,50}image|reached your.{0,30}limit|(?:图片|图像).{0,30}(?:限额|上限|额度)|已达到.{0,30}(?:上限|限制)|(?:还可生成|还能生成)\s*0\s*张|\b0\s+(?:images?\s+(?:left|remaining)|(?:more\s+)?images?\s+(?:available|generations?))\b/i.test(last + '\n' + alert + '\n' + composerStatus);
  const images = [...document.querySelectorAll('[data-message-author-role="assistant"] img, [data-testid="generated-image-preview"] img')]
    .filter(image => visible(image) && image.complete && image.naturalWidth >= 128 && image.naturalHeight >= 128)
    .map(image => ({ url: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight }));
  return { composer: !!editor, login, verification, busy: stop, quota, assistantDone: !!turns.length && !stop, images };
}

export function focusImageComposer() {
  const editor = [...document.querySelectorAll('#prompt-textarea, #mobile-composer-prompt, [role="textbox"][contenteditable="true"]')].find(element => !!(element.offsetWidth || element.offsetHeight));
  if (!editor) return false;
  editor.focus(); return true;
}

export function submitImageComposer() {
  const buttons = [...document.querySelectorAll('button')].filter(element => !!(element.offsetWidth || element.offsetHeight));
  const send = buttons.find(button => button.getAttribute('data-testid') === 'send-button' || /^(Send|Send prompt|Send message|发送|发送提示|发送消息)$/i.test(button.getAttribute('aria-label') || ''));
  if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return false;
  send.click(); return true;
}

export async function readGeneratedImage({ url, limit }) {
  if (!/^(?:blob:|data:image\/|https:\/\/)/.test(url)) throw new Error('Unsupported generated image address.');
  const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Generated image download failed.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error('Generated image exceeds the size limit.'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let binary = ''; for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}
