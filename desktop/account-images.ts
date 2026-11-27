import { accountAuth, type CodexAuth } from '../src/store.js';
import { expired } from '../src/auth.js';

const origin = 'https://chatgpt.com';
export const imageLimit = 24 * 1024 * 1024;
export const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
export function savedImageSession(accountHome: string) {
  try { return accountImageSession(accountAuth({ accountHome })); }
  catch { throw failure(401, 'The saved image account needs sign-in from its provider row.'); }
}

export async function parseAccountImageRequest({ raw, contentType, route }) {
  let body, files = [];
  if (/^multipart\/form-data/i.test(contentType)) {
    const form = await new Request(origin, { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData();
    body = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'));
    for (const [key, value] of form) if (typeof value !== 'string') {
      if (!['image', 'image[]'].includes(key)) throw failure(400, 'Account images do not support this image-edit field.');
      files.push({ type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
    }
  } else body = JSON.parse(raw.toString());
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) throw failure(400, 'Enter an image prompt of at most 16000 characters.');
  if (body.n != null && Number(body.n) !== 1) throw failure(400, 'Account image routing supports one image request at a time.');
  if (body.mask || body.markup || body.frame_count || body.svg) throw failure(400, 'Account image routing does not support masks, markup, animation or SVG controls.');
  if (body.images != null) {
    if (!Array.isArray(body.images)) throw failure(400, 'Invalid reference images.');
    for (const image of body.images) {
      const value = image?.image_url;
      const match = typeof value === 'string' && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/\r\n]+={0,2})$/.exec(value);
      if (!match) throw failure(400, 'Account image references must be inline PNG, JPEG, WebP or GIF files.');
      files.push({ type: match[1], bytes: Buffer.from(match[2], 'base64') });
    }
  }
  if (files.length > 5 || files.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || !file.bytes.length || file.bytes.length > imageLimit))
    throw failure(400, 'Use up to five reference images, each no larger than 24 MiB.');
  if (route.endsWith('/edits') && !files.length) throw failure(400, 'An image edit needs at least one reference image.');
  const prompt = body.prompt;
  return { prompt: 'Generate an image for the following request. Return the generated image.\n\n' + prompt
    + (body.background === 'transparent' ? '\n\nUse a transparent background.' : ''), files };
}

export function accountImageSession(auth: CodexAuth) {
  if (expired(auth)) throw failure(401, 'The saved account has expired. Sign in again from its provider row.');
  const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString());
  const identity = claims['https://api.openai.com/auth'] || {}, profile = claims['https://api.openai.com/profile'] || {};
  if (identity.chatgpt_account_id !== auth.tokens.account_id || !(identity.user_id || identity.chatgpt_user_id))
    throw failure(401, 'The saved image account identity is unavailable. Sign in again from its provider row.');
  return { accessToken: auth.tokens.access_token,
    ...(typeof claims.exp === 'number' ? { expires: new Date(claims.exp * 1000).toISOString() } : {}),
    user: { id: identity.user_id || identity.chatgpt_user_id, name: profile.name, email: profile.email },
    account: { id: auth.tokens.account_id, userId: identity.chatgpt_account_user_id, planType: identity.chatgpt_plan_type } };
}

export function initializeImagePage(html, login) {
  let initialized = false;
  const result = html.replace(/(<script\b[^>]*\bid=["']client-bootstrap["'][^>]*>)([\s\S]*?)(<\/script>)/i, (_all, open, source, close) => {
    const data = JSON.parse(source);
    data.authStatus = 'logged_in'; data.session = login;
    initialized = true;
    return open + JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029') + close;
  });
  if (!initialized) throw failure(503, 'The ChatGPT image page changed. Saved account and API image routes remain available.');
  return result;
}
