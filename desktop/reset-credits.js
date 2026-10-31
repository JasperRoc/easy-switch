import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { accountAuth, atomic } from '../src/store.js';

export function normalizeResetCredits(result) {
  const data = result?.rateLimitResetCredits;
  const seconds = value => Number.isSafeInteger(value) && value > 0 ? value * 1000 : null;
  const credits = Array.isArray(data?.credits) ? data.credits.filter(card => typeof card?.id === 'string' && card.id.trim()).map(card => ({
    id: card.id, resetType: card.resetType, status: card.status,
    title: typeof card.title === 'string' ? card.title.slice(0, 200) : null,
    description: typeof card.description === 'string' ? card.description.slice(0, 1000) : null,
    grantedAt: seconds(card.grantedAt), expiresAt: seconds(card.expiresAt), expiryKnown: card.expiresAt === null || seconds(card.expiresAt) !== null,
  })).sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) : null;
  return { availableCount: Number.isSafeInteger(data?.availableCount) && data.availableCount >= 0 ? data.availableCount : null, credits };
}

// These official account methods never create a conversation. Use an isolated
// credential store so selecting a card cannot change the native Codex sign-in.
export async function codexResetCredits({ binary, provider, creditId, idempotencyKey, spawnImpl = spawn, timeoutMs = 20000 }) {
  if (provider?.type !== 'account') throw new Error('Choose a subscription account.');
  const consume = creditId !== undefined;
  if (consume && (typeof creditId !== 'string' || !creditId.trim() || creditId.length > 512 ||
      typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)))
    throw new Error('Choose a reset card and retry.');
  const failure = () => new Error(consume ? 'Could not confirm the reset result. Retry the same card to avoid another redemption.' : 'Unable to read reset cards. Check the subscription and connection, then retry.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-switch-resets-'));
  let child, lines, timer, exited, originalAuth;
  try {
    originalAuth = JSON.stringify(accountAuth(provider));
    fs.writeFileSync(path.join(temp, 'auth.json'), JSON.stringify({ ...JSON.parse(originalAuth), auth_mode: 'chatgpt', OPENAI_API_KEY: null }), { mode: 0o600 });
    fs.writeFileSync(path.join(temp, 'config.toml'), 'cli_auth_credentials_store="file"\nforced_login_method="chatgpt"\n', { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env, CODEX_HOME: temp };
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
      child = spawnImpl(binary, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      exited = new Promise(done => child.once('close', done));
      child.stderr.resume();
      child.on('error', () => reject(failure())); child.stdin.on('error', () => reject(failure()));
      child.on('close', () => reject(failure())); timer = setTimeout(() => reject(failure()), timeoutMs);
      const send = (method, params, id) => child.stdin.write(JSON.stringify({ method, params, ...(id == null ? {} : { id }) }) + '\n');
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (![1, 2].includes(message.id)) return;
        if (message.error) return reject(failure());
        if (message.id === 1) {
          send('initialized', {});
          send(consume ? 'account/rateLimitResetCredit/consume' : 'account/rateLimits/read', consume ? { creditId, idempotencyKey } : {}, 2);
        } else resolve(message.result);
      });
      send('initialize', { clientInfo: { name: 'easy_switch_resets', version: '1.0.0' } }, 1);
    });
    if (!consume) return normalizeResetCredits(result);
    if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome)) throw failure();
    return { outcome: result.outcome };
  } finally {
    clearTimeout(timer); lines?.close();
    if (child) {
      child.stdin.end(); child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      await exited; clearTimeout(force);
    }
    if (originalAuth) {
      try {
        const refreshed = accountAuth({ accountHome: temp });
        if (JSON.stringify(accountAuth(provider)) === originalAuth && JSON.stringify(refreshed.tokens) !== JSON.stringify(JSON.parse(originalAuth).tokens))
          atomic(path.join(provider.accountHome, 'auth.json'), refreshed);
      } catch {}
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
