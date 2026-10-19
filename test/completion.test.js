import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidates, installCompletion, completionScript } from '../src/completion.js';
import { addProvider } from '../src/store.js';

test('completion exposes commands and aliases, excludes used order aliases and secrets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-complete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const alias of ['personal', 'relay']) addProvider(alias, { type: 'api', baseUrl: 'https://example.com/v1', apiKey: 'SECRET' }, root);
  assert.deepEqual(candidates(['per'], root), ['personal']);
  assert.deepEqual(candidates(['up'], root), ['update']);
  assert.deepEqual(candidates(['add', 'a'], root), ['api', 'account']);
  assert.deepEqual(candidates(['service', 're'], root), ['restart']);
  assert.deepEqual(candidates(['order', 'personal', ''], root), ['relay']);
  assert.deepEqual(candidates(['add', 'api', ''], root), []);
  assert.ok(!candidates([''], root).join().includes('SECRET'));
});
test('completion installation preserves shell configuration and is idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-shell-'"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.bashrc'), '# original\n');
  installCompletion(root, root);
  const first = fs.readFileSync(path.join(root, '.bashrc'), 'utf8');
  installCompletion(root, root);
  assert.equal(fs.readFileSync(path.join(root, '.bashrc'), 'utf8'), first);
  assert.ok(first.startsWith('# original\n'));
  for (const shell of ['bash', 'zsh']) {
    const check = spawnSync(shell, ['-n'], { input: completionScript(shell), encoding: 'utf8' });
    if (check.error?.code === 'ENOENT') continue;
    assert.equal(check.status, 0, check.stderr);
  }
});

test('Bash and Zsh completion scripts pass the current word and exclude used aliases', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-shell-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = new URL('../src/cli.js', import.meta.url);
  fs.symlinkSync(cli, path.join(root, 'switch'));
  for (const alias of ['personal', 'relay']) addProvider(alias, { type: 'api', baseUrl: 'https://example.com', apiKey: 'SECRET' }, root);
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, SWITCH_HOME: root };
  const scripts = {
    bash: completionScript('bash') + '\nCOMP_WORDS=(switch order personal re); COMP_CWORD=3; _easy_switch_complete; printf "%s\\n" "${COMPREPLY[@]}"',
    zsh: 'compdef() { :; }\n' + completionScript('zsh') + '\ncompadd() { shift; printf "%s\\n" "$@"; }; words=(switch order personal re); CURRENT=4; _easy_switch_complete',
  };
  for (const [shell, script] of Object.entries(scripts)) {
    const result = spawnSync(shell, ['-c', script], { env, encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') continue;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'relay');
  }
});
