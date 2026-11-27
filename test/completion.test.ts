import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidates, installCompletion, completionScript } from '../src/completion.js';
import { addProvider } from '../src/store.js';
import { installLauncher } from '../src/linux-package.js';

test('completion exposes only fd commands, client aliases and argument positions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-complete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const alias of ['personal', 'relay']) addProvider(alias, { type: 'api', baseUrl: 'https://example.test', apiKey: 'SECRET' }, root);
  addProvider('claude-only', { type: 'api', baseUrl: 'https://example.test', apiKey: 'SECRET' }, path.join(root, 'claude'));
  assert.deepEqual(candidates([''], root), ['add','edit','rm','ls','order','cc','update','uninstall','help','personal','relay']);
  assert.deepEqual(candidates(['cc', 'rm', ''], root), ['claude-only']);
  assert.deepEqual(candidates(['rm', 're'], root), ['relay']);
  assert.deepEqual(candidates(['add', 'a'], root), ['account', 'api']);
  assert.deepEqual(candidates(['order', ''], root), []);
  assert.deepEqual(candidates(['sy'], root), []); assert.deepEqual(candidates(['service', ''], root), []);
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
  installLauncher(root);
  for (const alias of ['personal', 'relay']) addProvider(alias, { type: 'api', baseUrl: 'https://example.com', apiKey: 'SECRET' }, root);
  const env = { ...process.env, PATH: `${path.join(root, '.local', 'bin')}:${process.env.PATH}`, SWITCH_HOME: root };
  const scripts = {
    bash: completionScript('bash') + '\nCOMP_WORDS=(fd rm re); COMP_CWORD=2; _fluid_complete; printf "%s\\n" "${COMPREPLY[@]}"',
    zsh: 'compdef() { :; }\n' + completionScript('zsh') + '\ncompadd() { shift; printf "%s\\n" "$@"; }; words=(fd rm re); CURRENT=3; _fluid_complete',
  };
  for (const [shell, script] of Object.entries(scripts)) {
    const result = spawnSync(shell, ['-c', script], { env, encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') continue;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'relay');
  }
});

test('uninstall removes only the managed shell completion blocks and generated files',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'switch-completion-remove-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {removeCompletion}=await import('../src/completion.js');
 for(const rc of ['.bashrc','.zshrc'])fs.writeFileSync(path.join(root,rc),'# user preferences\nexport MY_SETTING=1\n');
 installCompletion(root,root);removeCompletion(root,root);
 for(const rc of ['.bashrc','.zshrc']){const content=fs.readFileSync(path.join(root,rc),'utf8');assert.match(content,/export MY_SETTING=1/);assert.doesNotMatch(content,/fluid/);}
 assert.equal(fs.existsSync(path.join(root,'.local','share','fluid')),false);
});
