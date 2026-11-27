import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { parse } from 'smol-toml';
import { McpSettings } from '../src/mcp-settings.js';
import { SkillSettings } from '../src/skill-settings.js';
import { codexSession } from '../src/sync-codex.js';

function fixture(t) {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-extensions-'));
  const root = path.join(userHome, 'switch'), codexHome = path.join(userHome, 'codex'), claudeHome = path.join(userHome, 'claude');
  for (const directory of [root, codexHome, claudeHome]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  return { userHome, root, codexHome, claudeHome, env: { CLAUDE_CONFIG_DIR: claudeHome } };
}

test('MCP keeps independently edited client configs, supports SSE in Claude and preserves unrelated settings', async t => {
  const directories = fixture(t);
  const settings = new McpSettings(directories), file = settings.files.claude;
  const original = { numStartups: 12, projects: { '/repo': { mcpServers: { private: { command: 'example' } } } },
    mcpServers: { same: { type: 'sse', url: 'https://example.test/events', headers: { Authorization: 'Bearer fixture' } } } };
  fs.writeFileSync(file, JSON.stringify(original));
  fs.writeFileSync(settings.files.codex, '# comment\n[mcp_servers.same]\ncommand = "echo"\n[mcp_servers.same.env]\nPRIVATE = "fixture"\n');
  const [listed] = settings.list();
  assert.deepEqual(listed.enabled, { codex: true, claude: true });
  assert.doesNotMatch(JSON.stringify(listed), /example.test|Bearer|PRIVATE/);
  const change = (operation, fields = {}) => settings.change({ operation, name: 'same', client: 'claude', ...fields });
  await change('toggle', { enable: false });
  assert.equal(settings.list()[0].enabled.claude, false);
  assert.equal(settings.details({ name: 'same', client: 'claude' }).config.type, 'sse');
  await change('toggle', { enable: true });
  await assert.rejects(change('edit', { expected: { type: 'stdio', command: 'other' }, text: '{"command":"echo"}' }), /changed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  await assert.rejects(settings.change({ operation: 'add', client: 'codex', text: '{"mcpServers":{"legacy":{"type":"sse","url":"https://example.test/sse"}}}' }), /Streamable HTTP/);
});

test('Codex MCP writes keep comments, provider configuration and siblings through edit, disable and removal', { skip: !process.env.SWITCH_TEST_CODEX }, async t => {
  const settings = new McpSettings({ ...fixture(t), binary: process.env.SWITCH_TEST_CODEX });
  const file = settings.files.codex;
  fs.writeFileSync(file, '# user comment\nmodel = "fixture"\n[mcp_servers.sibling]\ncommand = "echo"\n[features]\n# Do not rewrite this\nimage_generation = true\n');
  await settings.change({ operation: 'add', client: 'codex', text: '[mcp_servers.demo]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "MCP_TOKEN"\n' });
  const edit = { name: 'demo', client: 'codex' };
  const change = (operation, fields) => settings.change({ ...edit, ...fields, operation });
  await change('toggle', { enable: false });
  const disabled = settings.details(edit);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.config.bearer_token_env_var, 'MCP_TOKEN');
  await change('edit', { expected: disabled.config, text: '{"url":"https://example.test/v2"}' });
  assert.equal(settings.details(edit).enabled, false);
  await change('toggle', { enable: true });
  assert.equal(settings.details(edit).enabled, true);
  await change('remove', { expected: settings.details(edit).config });
  const current = fs.readFileSync(file, 'utf8');
  assert.match(current, /^# user comment/); assert.match(current, /# Do not rewrite this/);
  assert.deepEqual(Object.keys(parse(current).mcp_servers), ['sibling']);
  assert.equal(parse(current).mcp_servers.sibling.command, 'echo');
});

test('Codex discovers an enabled Skill and the tools of a saved MCP server', { skip: !process.env.SWITCH_TEST_CODEX }, async t => {
  const dirs = fixture(t), binary = process.env.SWITCH_TEST_CODEX;
  const script = path.join(dirs.root, 'fixture-mcp.cjs');
  fs.writeFileSync(script, `
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } };
  else if (method === 'tools/list') result = { tools: [{ name: 'fixture_echo', description: 'Fixture tool', inputSchema: { type: 'object' } }] };
  else return;
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
});
`);
  const installed = path.join(dirs.codexHome, 'skills', 'fixture-skill');
  makeSkill(installed, 'fixture-skill');
  const settings = new SkillSettings({ ...dirs, binary });
  await settings.change({ operation: 'toggle', name: 'fixture-skill', client: 'codex', enable: true });
  const mcp = new McpSettings({ ...dirs, binary });
  await mcp.change({ client: 'codex', operation: 'add', name: 'fixture', text: JSON.stringify({ command: process.execPath, args: [script] }) });
  await codexSession({ binary, codexHome: dirs.codexHome }, async call => {
    const skills = await call('skills/list', { cwds: [dirs.root], forceReload: true });
    assert.equal(skills.data[0].skills.find(item => item.name === 'fixture-skill')?.enabled, true);
    const result = await call('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
    const server = result.data.find(item => item.name === 'fixture');
    assert.ok(Object.values(server?.tools || {}).some(tool => tool.name === 'fixture_echo'), JSON.stringify(result.data.map(({ name, tools }) => ({ name, tools: Object.keys(tools) }))));
  });
});

function makeSkill(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\nInstructions.\n`);
}
test('existing Skills can be toggled in place and enabled in another client with their supporting files', async t => {
  const dirs = fixture(t), skills = new SkillSettings(dirs);
  const existing = path.join(dirs.claudeHome, 'skills', 'existing');
  makeSkill(existing, 'existing-command');
  fs.writeFileSync(path.join(existing, 'reference.txt'), 'fixture reference');
  const file = path.join(dirs.claudeHome, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ skillOverrides: { other: 'name-only' }, permissions: { defaultMode: 'default' } }));
  assert.equal((await skills.list())[0].managed, false);
  const toggle = (client, enable) => skills.change({ operation: 'toggle', name: 'existing', client, enable });
  assert.equal((await toggle('claude', false))[0].enabled.claude, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { skillOverrides: { other: 'name-only', 'existing-command': 'off' }, permissions: { defaultMode: 'default' } });
  assert.equal((await toggle('claude', true))[0].enabled.claude, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).skillOverrides, { other: 'name-only' });
  const cross = await skills.change({ operation: 'toggle', name: 'existing', client: 'codex', enable: true });
  assert.deepEqual(cross[0].enabled, { codex: true, claude: true });
  assert.equal(cross[0].managed, true);
  const copy = path.join(dirs.userHome, '.agents', 'skills', 'existing');
  assert.equal(fs.readFileSync(path.join(copy, 'reference.txt'), 'utf8'), 'fixture reference');
  await skills.change({ operation: 'remove', name: 'existing', client: 'codex' });
  assert.equal(fs.existsSync(copy), false); assert.equal(fs.existsSync(existing), true);
});

test('Codex Skills toggle overrides an existing name rule for a linked Skill without changing the source', { skip: !process.env.SWITCH_TEST_CODEX }, async t => {
  const dirs = fixture(t), binary = process.env.SWITCH_TEST_CODEX;
  const settings = new SkillSettings({ ...dirs, binary });
  const existing = path.join(dirs.userHome, 'fixture-toggle');
  makeSkill(existing, 'fixture-toggle');
  fs.mkdirSync(path.join(dirs.codexHome, 'skills'));
  fs.symlinkSync(existing, path.join(dirs.codexHome, 'skills', 'fixture-toggle'), 'junction');
  const skill = path.join(existing, 'SKILL.md'), original = fs.readFileSync(skill, 'utf8');
  const file = path.join(dirs.codexHome, 'config.toml');
  fs.writeFileSync(file, '# user comment\nmodel = "fixture"\n[[skills.config]]\nname = "fixture-toggle"\nenabled = false\n[[skills.config]]\nname = "unrelated"\nenabled = false\n');
  const codexEnabled = () => codexSession({ binary, codexHome: dirs.codexHome }, async call => {
    const { data } = await call('skills/list', { cwds: [dirs.root], forceReload: true });
    return data[0].skills.find(item => item.name === 'fixture-toggle')?.enabled;
  });
  assert.equal((await settings.list())[0].enabled.codex, false);
  assert.equal(await codexEnabled(), false);
  const toggle = enable => settings.change({ operation: 'toggle', name: 'fixture-toggle', client: 'codex', enable });
  assert.equal((await toggle(true))[0].enabled.codex, true);
  assert.equal(await codexEnabled(), true);
  assert.equal((await toggle(false))[0].enabled.codex, false);
  assert.equal(await codexEnabled(), false);
  const config = fs.readFileSync(file, 'utf8');
  assert.match(config, /^# user comment/);
  assert.deepEqual(parse(config).skills.config.filter(rule => rule.name).map(rule => ({ ...rule })), [{ name: 'fixture-toggle', enabled: false }, { name: 'unrelated', enabled: false }]);
  assert.equal(fs.readFileSync(skill, 'utf8'), original);
});

test('ZIP and GitHub skill discovery preserve assets and refuse linked entries', { skip: spawnSync('zip', ['-v']).status !== 0 }, async t => {
  const dirs = fixture(t), settings = new SkillSettings(dirs);
  const source = path.join(dirs.userHome, 'repository', 'skills', 'sample');
  makeSkill(source, 'sample');
  fs.writeFileSync(path.join(source, 'notes.txt'), 'fixture');
  const archive = path.join(dirs.userHome, 'skills.zip');
  execFileSync('zip', ['-rq', archive, 'skills'], { cwd: path.join(dirs.userHome, 'repository') });
  const zip = await settings.discover({ source: archive, kind: 'zip' });
  assert.equal(zip.candidates[0].id, 'skills/sample');
  const github = await settings.discover({ source: 'https://github.com/example/skills', kind: 'github', fetch: async (url, options) => {
    assert.equal(url, 'https://codeload.github.com/example/skills/zip/HEAD');
    assert.equal(options.redirect, 'error');
    return new Response(fs.readFileSync(archive));
  } });
  assert.deepEqual(github, zip);
  await settings.import({ id: 'skills/sample', client: 'claude' });
  assert.equal(fs.readFileSync(path.join(dirs.claudeHome, 'skills', 'sample', 'notes.txt'), 'utf8'), 'fixture');
  if (process.platform === 'win32') return;
  fs.symlinkSync('../outside', path.join(source, 'link'));
  const invalid = path.join(dirs.userHome, 'linked.zip');
  execFileSync('zip', ['-rqy', invalid, 'skills'], { cwd: path.join(dirs.userHome, 'repository') });
  await assert.rejects(settings.discover({ source: invalid, kind: 'zip' }), /unsupported files/);
});

test('one-click Skill updates reuse a repository download and preserve switches and locally edited copies', { skip: spawnSync('zip', ['-v']).status !== 0 }, async t => {
  const dirs = fixture(t), settings = new SkillSettings(dirs);
  const repo = 'https://github.com/example/skills';
  const repository = path.join(dirs.userHome, 'skills-HEAD');
  const names = ['first', 'edited', 'legacy'];
  for (const name of names) {
    const folder = path.join(repository, 'skills', name);
    makeSkill(folder, name);
    fs.writeFileSync(path.join(folder, 'note.txt'), 'Version 1');
  }
  let revision = 0, downloads = 0, archive;
  const bundle = () => {
    const file = path.join(dirs.userHome, `version-${++revision}.zip`);
    execFileSync('zip', ['-rq', file, 'skills-HEAD'], { cwd: dirs.userHome });
    archive = fs.readFileSync(file);
  };
  const fetch = async url => {
    assert.equal(url, 'https://codeload.github.com/example/skills/zip/HEAD');
    downloads++;
    return new Response(archive);
  };
  bundle();
  await settings.discover({ source: repo, kind: 'github', fetch });
  for (const name of names.slice(0, 2)) await settings.import({ id: 'skills/' + name, client: 'claude' });
  await settings.change({ operation: 'toggle', name: 'first', client: 'codex', enable: true });
  await settings.change({ operation: 'toggle', name: 'first', client: 'claude', enable: false });
  const claudeSettings = fs.readFileSync(path.join(dirs.claudeHome, 'settings.json'), 'utf8');

  await settings.discover({ source: path.join(repository, 'skills', 'legacy'), kind: 'folder' });
  await settings.import({ id: '.', client: 'claude' });
  assert.equal((await settings.list()).find(row => row.name === 'legacy').updatable, false);
  await settings.discover({ source: repo, kind: 'github', fetch });
  await assert.rejects(settings.import({ id: 'skills/first', link: 'legacy' }), /does not contain/);
  await settings.import({ id: 'skills/legacy', link: 'legacy' });
  await settings.discard();

  const note = (client, name) => path.join(settings.directories[client][0], name, 'note.txt');
  fs.writeFileSync(note('claude', 'edited'), 'Local edit');
  for (const name of names) fs.writeFileSync(path.join(repository, 'skills', name, 'note.txt'), 'Version 2');
  bundle();
  const before = downloads;
  const result = await settings.updateAll({ fetch });
  assert.equal(downloads, before + 1);
  assert.equal(result.updated, 2);
  assert.deepEqual(result.failures, [{ name: 'edited', message: 'This Skill has local changes.' }]);
  assert.deepEqual(result.rows.find(row => row.name === 'first').enabled, { codex: true, claude: false });
  assert.equal(fs.readFileSync(path.join(dirs.claudeHome, 'settings.json'), 'utf8'), claudeSettings);
  for (const client of ['codex', 'claude']) assert.equal(fs.readFileSync(note(client, 'first'), 'utf8'), 'Version 2');
  assert.equal(fs.readFileSync(note('claude', 'legacy'), 'utf8'), 'Version 2');
  assert.equal(fs.readFileSync(note('claude', 'edited'), 'utf8'), 'Local edit');
  assert.equal(fs.readFileSync(path.join(settings.library, 'edited', 'note.txt'), 'utf8'), 'Version 1');
  assert.equal(fs.existsSync(path.join(dirs.claudeHome, 'skills', 'first', '.fluid-skill-source.json')), false);
  assert.equal(fs.existsSync(settings.staging), false);
  fs.writeFileSync(note('claude', 'edited'), 'Version 1');
  assert.equal((await settings.updateAll({ fetch })).updated, 1, 'a later update can retry the preserved copy');
  const unchanged = await settings.updateAll({ fetch });
  assert.equal(unchanged.updated, 0);
  assert.deepEqual(unchanged.failures, []);

  fs.writeFileSync(path.join(repository, 'skills', 'first', 'note.txt'), 'Version 3');
  bundle();
  const libraryCopy = fs.realpathSync(path.join(settings.library, 'first')), rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === libraryCopy && path.basename(source) === 'next') throw new Error('Replacement blocked');
    rename(source, target);
  });
  syncBuiltinESMExports();
  try {
    const blocked = await settings.updateAll({ fetch });
    assert.equal(blocked.updated, 0);
    assert.deepEqual(blocked.failures, [{ name: 'first', message: 'Replacement blocked' }]);
    assert.equal(fs.readFileSync(path.join(libraryCopy, 'note.txt'), 'utf8'), 'Version 2');
    for (const client of ['codex', 'claude']) assert.equal(fs.readFileSync(note(client, 'first'), 'utf8'), 'Version 2');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await settings.updateAll({ fetch })).updated, 1);
});

test('canceling a GitHub skill download removes the partial preview', async t => {
  const settings = new SkillSettings(fixture(t)), controller = new AbortController();
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  const pending = settings.discover({ source: 'https://github.com/example/skills', kind: 'github', signal: controller.signal,
    fetch: async (_url, { signal }) => new Response(new ReadableStream({ start(stream) {
      signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      stream.enqueue(Buffer.from('partial data'));
      started();
    } })) });
  await fetching; controller.abort();
  await assert.rejects(pending, /Unable to download/);
  assert.equal(fs.existsSync(settings.staging), false);
});
