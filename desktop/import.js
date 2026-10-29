import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { baseURL } from '../src/store.js';
import { expired } from '../src/auth.js';

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('Unable to read the existing Codex configuration.'); }
}
export function existingProvider({ codexHome, root, env }) {
  let config, auth;
  try {
    config = parse(read(path.join(codexHome, 'config.toml')));
    auth = JSON.parse(read(path.join(codexHome, 'auth.json')) || '{}');
    if (config.model_provider === 'easy_switch') {
      const record = JSON.parse(read(path.join(root, 'desktop-session.json')) || '{}');
      if (record.file !== path.join(codexHome, 'config.toml') || typeof record.original !== 'string')
        throw new Error();
      config.model_provider = parse(record.original).model_provider;
    }
  } catch { throw new Error('Unable to read the existing Codex configuration.'); }
  const id = config.model_provider || 'openai', provider = config.model_providers?.[id] || {};
  if (id !== 'openai' && !provider.base_url) throw new Error('The current Codex provider has no API base URL. Add an API provider manually.');
  if (provider.wire_api && provider.wire_api !== 'responses') throw new Error('The current API uses an unsupported protocol. A Responses-compatible provider is required.');
  const bearer = Object.entries(provider.http_headers || {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  let key = provider.experimental_bearer_token || (typeof bearer === 'string' ? bearer.match(/^Bearer\s+(.+)$/i)?.[1] : '');
  if (!key && provider.env_key) {
    key = env[provider.env_key];
    if (!key) throw new Error('The API key environment variable is unavailable to this app. Use Add API provider to enter the key.');
  }
  const account = id === 'openai' && !key && auth.auth_mode !== 'apikey' && auth.tokens?.access_token && auth.tokens?.account_id;
  if (account) {
    if (expired(auth)) throw new Error('The existing Codex sign-in has expired. Use device sign-in instead.');
    return { type: 'account', name: 'codex-account', auth };
  }
  key ||= (id === 'openai' || provider.requires_openai_auth === true ? auth.OPENAI_API_KEY : '') ||
    (id === 'openai' ? env.OPENAI_API_KEY || env.CODEX_API_KEY : '');
  if (!key || typeof key !== 'string' || !key.trim())
    throw new Error('No readable Codex credentials were found. Use Add subscription or Add API provider.');
  if (Object.keys(provider.env_http_headers || {}).length || Object.keys(provider.http_headers || {}).some(name => name.toLowerCase() !== 'authorization'))
    throw new Error('This provider requires custom headers that cannot be imported automatically.');
  return { type: 'api', name: id === 'openai' ? 'codex-api' : id, baseUrl: baseURL(provider.base_url || ''), apiKey: key.trim() };
}
