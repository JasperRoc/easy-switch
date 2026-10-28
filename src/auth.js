import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { accountAuth, atomic } from './store.js';

function subject(auth) {
  for (const token of [auth.tokens.id_token, auth.tokens.access_token]) {
    try { const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub; if (typeof sub === 'string') return sub; } catch { /* opaque token */ }
  }
}
export function expired(auth) {
  try {
    const payload = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url'));
    return typeof payload.exp === 'number' && payload.exp <= Date.now() / 1000;
  } catch { return false; } // Opaque tokens are checked by the upstream instead.
}

// A single device login per account; no credentials or device codes go to service logs.
export function createReauth({ spawnImpl = spawn, timeoutMs = 300000, promptWaitMs = 8000 } = {}) {
  const sessions = new Map();
  function begin(provider) {
    const key = provider.accountHome;
    if (sessions.has(key)) return sessions.get(key);
    let expected; let expectedSubject;
    try { const auth = accountAuth(provider); expected = auth.tokens.account_id; expectedSubject = subject(auth); } catch { /* missing cache */ }
    const temp = fs.mkdtempSync(path.join(path.dirname(key), '.reauth-'));
    fs.chmodSync(temp, 0o700);
    const session = { message: 'Starting account authentication. Retry this request shortly to display the sign-in link.' };
    sessions.set(key, session);
    let ready, complete;
    session.completed = new Promise(resolve => { complete = resolve; });
    session.ready = new Promise(resolve => { ready = resolve; });
    const child = spawnImpl(process.env.SWITCH_CODEX_BIN || 'codex', ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'], {
      env: { ...process.env, CODEX_HOME: temp }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    session.child = child;
    let output = '';
    const read = chunk => {
      output = stripVTControlCharacters(output + chunk.toString()).slice(-8192);
      // Only expose the official verification URL and device code, never raw child output.
      const url = output.match(/https:\/\/auth\.openai\.com\/codex\/device\b/);
      const code = output.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/);
      if (url && code) {
        session.message = `Account authentication required. Open ${url[0]} and enter code ${code[0]}. Sign in to the same account, then retry your request.`;
        ready();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    let finished = false;
    const promptTimer = setTimeout(ready, promptWaitMs);
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false, 'Authentication timed out. Retry your request to start again.');
    }, timeoutMs);
    function finish(success, message) {
      if (finished) return;
      finished = true;
      clearTimeout(promptTimer); clearTimeout(deadline);
      let accepted = false;
      if (success) {
        try {
          const auth = accountAuth({ accountHome: temp });
          if ((expected && auth.tokens.account_id !== expected) || (expectedSubject && subject(auth) !== expectedSubject)) throw new Error('Different account');
          atomic(path.join(key, 'auth.json'), auth);
          sessions.delete(key);
          accepted = true;
          session.message = 'Authentication complete. Retry your request.';
        } catch { session.message = 'Authentication did not restore the same account. Original credentials were preserved. Retry to sign in again.'; }
      } else session.message = message;
      ready();
      complete({ success: accepted, message: session.message });
      fs.rmSync(temp, { recursive: true, force: true });
      if (sessions.has(key)) {
        session.cleanup = setTimeout(() => sessions.delete(key), 10000);
        session.cleanup.unref();
      }
    }
    child.on('error', () => finish(false, 'Unable to start authentication. Check that the service can run Codex CLI.'));
    child.on('close', code => finish(code === 0, 'Authentication failed. Enable device code login in your ChatGPT settings, then retry.'));
    session.stop = () => { child.kill('SIGKILL'); finish(false, 'Authentication cancelled.'); clearTimeout(session.cleanup); };
    return session;
  }
  return {
    start(provider) { const session = begin(provider); return { ready: session.ready.then(() => session.message), completed: session.completed }; },
    async prompt(provider) { const session = begin(provider); await session.ready; return session.message; },
    close() { for (const session of sessions.values()) session.stop(); sessions.clear(); },
  };
}
