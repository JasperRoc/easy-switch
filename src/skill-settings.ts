import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream, renameSync } from 'node:fs';
import yauzl from 'yauzl';
import { parse } from 'smol-toml';
import { extensionClients } from './mcp-settings.js';
import { atomic, type Client } from './store.js';
import { codexSession, type CodexConfigResult } from './sync-codex.js';
import type { UpstreamFetch } from './network.js';
import type { CodexExecutable } from './codex-binary.js';

interface ZipEntry { fileName: string; externalFileAttributes: number; uncompressedSize: number; }
interface ZipFile {
  eachEntry(): AsyncIterable<ZipEntry>;
  openReadStream(entry: ZipEntry, done: (error: Error | null, value: Readable) => void): void;
  close(): void;
}
interface SkillRow {
  name: string; title: string; description: string; managed: boolean; enabled: Partial<Record<Client, boolean>>; updatable: boolean;
}
interface SkillSource { repository: string; id: string; hash?: string; }
type SkillCandidate = { id: string; name: string } & Awaited<ReturnType<typeof metadata>>;

const marker = '.fluid-skill';
const sourceFile = '.fluid-skill-source.json';
const ignoredFiles = new Set(['.git', '.DS_Store', marker, sourceFile]);
const validDirectory = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name) &&
  !/[.]$/.test(name) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) && name.toLowerCase() !== 'synced';
const invalidArchive = () => new Error('The ZIP contains unsafe paths or unsupported files.');
const MAX_SKILL_DOWNLOAD = 50 * 1024 * 1024;
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function readMarker(directory) {
  if (!(await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; }))?.isDirectory()) return '';
  const file = path.join(directory, marker);
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  return stat?.isFile() && stat.size === 36 ? await fs.readFile(file, 'utf8') : '';
}
const promise = <T>(operation: (done: (error: Error | null, value: T) => void) => void) => new Promise<T>((resolve, reject) => operation((error, value) => error ? reject(error) : resolve(value)));

async function unzip(file, directory) {
  const zip = await promise<ZipFile>(done => yauzl.open(file, { lazyEntries: true, strictFileNames: true }, done));
  let size = 0, count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const parts = entry.fileName.replace(/\/$/, '').split('/');
      if (parts[0] === '__MACOSX') continue;
      if (parts.some(part => !part || /^\.{1,2}$|[<>:"\\|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))
        throw invalidArchive();
      const mode = entry.externalFileAttributes >>> 16;
      if ((mode & 0o170000) && ![0o040000, 0o100000].includes(mode & 0o170000)) throw invalidArchive();
      size += entry.uncompressedSize;
      if (++count > 10000 || size > 100 * 1024 * 1024) throw new Error('This skills archive is too large.');
      const target = path.join(directory, ...parts);
      if (entry.fileName.endsWith('/')) await fs.mkdir(target, { recursive: true, mode: 0o700 });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const stream = await promise<Readable>(done => zip.openReadStream(entry, done));
        await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: mode & 0o111 ? 0o700 : 0o600 }));
      }
    }
  } finally { zip.close(); }
}

function githubRepository(value) {
  let url;
  try { url = new URL(value); } catch {}
  const match = url && /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(url.pathname);
  if (url?.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !match)
    throw new Error('Enter a GitHub repository URL such as https://github.com/owner/repo.');
  return `https://codeload.github.com/${match[1]}/${match[2].replace(/\.git$/, '')}/zip/HEAD`;
}

async function download(url: string, file: string, fetch: UpstreamFetch, signal?: AbortSignal) {
  const controller = new AbortController();
  const idle = setTimeout(() => controller.abort(), 30000);
  const signals = [controller.signal, AbortSignal.timeout(300000)];
  if (signal) signals.push(signal);
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any(signals) });
    if (!response.ok || !response.body) throw new Error();
    if (Number(response.headers.get('content-length')) > MAX_SKILL_DOWNLOAD) throw new Error('This skills archive is too large.');
    await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), async function* (stream) {
      let size = 0;
      for await (const chunk of stream) {
        idle.refresh();
        if ((size += chunk.length) > MAX_SKILL_DOWNLOAD) throw new Error('This skills archive is too large.');
        yield chunk;
      }
    }, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (error.message === 'This skills archive is too large.') throw error;
    throw new Error('Unable to download this public GitHub skills repository.');
  } finally {
    clearTimeout(idle);
    controller.abort();
  }
}

async function metadata(directory) {
  const file = path.join(directory, 'SKILL.md');
  const stat = await fs.lstat(file).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; return undefined; });
  if (!stat?.isFile() || stat.size > 1024 * 1024) return null;
  const content = await fs.readFile(file, 'utf8');
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] || '';
  const field = key => new RegExp('^' + key + ':[ \\t]*([^\\r\\n]+)', 'm').exec(frontmatter)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  const description = field('description');
  return { title: field('name') || path.basename(directory), description: description && !/^[>|][-+]?$/.test(description) ? description : '' };
}

async function findSkills(directory: string, all: SkillCandidate[], prefix = '') {
  const info = await metadata(directory);
  if (info && validDirectory(path.basename(directory))) {
    all.push({ id: prefix || '.', name: path.basename(directory), ...info });
    return;
  }
  for (const entry of await fs.readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name !== 'node_modules' &&
        (!entry.name.startsWith('.') || ['.agents', '.claude', '.codex'].includes(entry.name)))
      await findSkills(path.join(directory, entry.name), all, prefix ? prefix + '/' + entry.name : entry.name);
}

async function copySkill(source, target, nonce) {
  if (!(await fs.lstat(source)).isDirectory()) throw new Error('Import a regular skill folder.');
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(path.dirname(target), '.import-'));
  try {
    const copy = path.join(staging, path.basename(target));
    await fs.cp(source, copy, { recursive: true, errorOnExist: true, force: false, filter: async file => {
      if (ignoredFiles.has(path.basename(file))) return false;
      const stat = await fs.lstat(file);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('A skill contains symbolic links or special files. Import a regular folder.');
      return true;
    } });
    if (!await metadata(copy)) throw new Error('No skill folders containing SKILL.md were found.');
    await fs.writeFile(path.join(copy, marker), nonce, { flag: 'wx', mode: 0o600 });
    if (await exists(target)) throw new Error('A skill with that folder name already exists.');
    await fs.rename(copy, target);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function readConfig(file, parseConfig) {
  const source = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
  return source === undefined ? {} : parseConfig(source);
}

async function skillHash(directory) {
  const hash = createHash('sha256');
  async function add(folder, prefix = '') {
    for (const name of (await fs.readdir(folder)).sort()) {
      if (ignoredFiles.has(name)) continue;
      const file = path.join(folder, name), relative = prefix + name;
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([relative, 'directory']));
        await add(file, relative + '/');
      } else if (stat.isFile()) {
        const content = createHash('sha256');
        for await (const chunk of createReadStream(file)) content.update(chunk);
        hash.update(JSON.stringify([relative, stat.mode & 0o111, content.digest('hex')]));
      } else throw new Error('A skill contains symbolic links or special files. Import a regular folder.');
    }
  }
  await add(directory);
  return hash.digest('hex');
}

async function replaceSkill(source, targets, nonce, origin, nextHash) {
  const [library, ...copies] = targets;
  const staged = [];
  let committed = false;
  try {
    for (const target of [...copies, library]) {
      const current = await skillHash(target);
      if (current === nextHash && target !== library) continue;
      if (current !== origin.hash && current !== nextHash) throw new Error('This Skill has local changes.');
      const folder = await fs.mkdtemp(path.join(path.dirname(target), '.update-'));
      const entry = { target, current, folder, next: path.join(folder, 'next'), backup: path.join(folder, 'previous') };
      staged.push(entry);
      await copySkill(source, entry.next, nonce);
      if (target === library) atomic(path.join(entry.next, sourceFile), { ...origin, hash: nextHash });
    }
    for (const entry of staged) {
      if (await readMarker(entry.target) !== nonce || await skillHash(entry.target) !== entry.current)
        throw new Error('This Skill changed during the update.');
    }
    // Keep the rename and rollback together so quitting cannot leave a half-installed Skill.
    try {
      for (const entry of staged) {
        renameSync(entry.target, entry.backup);
        entry.backedUp = true;
        renameSync(entry.next, entry.target);
        entry.installed = true;
      }
    } catch (error) {
      let recoveryError;
      for (const entry of [...staged].reverse()) {
        if (!entry.backedUp) continue;
        try {
          if (entry.installed) renameSync(entry.target, entry.next);
          renameSync(entry.backup, entry.target);
          entry.backedUp = false;
        } catch (failure) { recoveryError ||= failure; }
      }
      throw recoveryError || error;
    }
    committed = true;
  } finally {
    // Keep the backup on disk if the OS blocked its rollback.
    for (const entry of staged)
      if (committed || !entry.backedUp) await fs.rm(entry.folder, { recursive: true, force: true });
  }
}

export class SkillSettings {
  declare codexHome: string;
  declare binary: CodexExecutable;
  declare claudeConfig: string;
  declare library: string;
  declare staging: string;
  declare directories: Record<Client, string[]>;
  declare preview?: { directory: string; candidates: SkillCandidate[]; repository: string };

  constructor({ root, codexHome, claudeHome, binary, userHome = os.homedir() }) {
    Object.assign(this, { codexHome, binary });
    this.claudeConfig = path.join(claudeHome, 'settings.json');
    this.library = path.join(root, 'skills');
    this.staging = path.join(root, 'skill-preview');
    const agents = path.join(userHome, '.agents', 'skills');
    const legacy = path.join(codexHome, 'skills');
    this.directories = { codex: [...new Set([agents, legacy])], claude: [path.join(claudeHome, 'skills')] };
  }
  async clientCopies(name, client) {
    const copies = [];
    for (const directory of this.directories[client]) {
      const folder = path.join(directory, name), info = await metadata(folder);
      if (info) copies.push({ folder, ...info });
    }
    return copies;
  }
  async list() {
    const [codex, claude] = await Promise.all([
      readConfig(path.join(this.codexHome, 'config.toml'), parse),
      readConfig(this.claudeConfig, JSON.parse),
    ]);
    const rows = new Map<string, SkillRow>();
    const scan = async (parent: string, client?: Client) => {
      let entries;
      try { entries = await fs.readdir(parent, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (!validDirectory(entry.name) || !entry.isDirectory() && !(client && entry.isSymbolicLink())) continue;
        const folder = path.join(parent, entry.name), info = await metadata(folder);
        if (!info) continue;
        let row = rows.get(entry.name);
        if (!row) {
          const managed = !client;
          rows.set(entry.name, row = { name: entry.name, ...info, managed, enabled: {},
            updatable: managed && await exists(path.join(folder, sourceFile)) });
        }
        if (!client) continue;
        let enabled;
        if (client === 'codex') {
          const file = path.join(folder, 'SKILL.md'), real = await fs.realpath(file);
          const rule = codex.skills?.config?.findLast(item => item.path === file || item.path === real || item.name === info.title);
          enabled = rule?.enabled !== false;
        } else {
          enabled = claude.skillOverrides?.[info.title] !== 'off';
        }
        row.enabled[client] ||= enabled;
      }
    };
    await scan(this.library);
    for (const client of extensionClients) for (const directory of this.directories[client]) await scan(directory, client);
    return [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));
  }
  async discard() {
    if (!this.preview) return;
    this.preview = null;
    await fs.rm(this.staging, { recursive: true, force: true });
  }
  async discover({ source, kind, fetch, signal }: { source: string; kind: 'folder' | 'zip' | 'github'; fetch?: UpstreamFetch; signal?: AbortSignal }) {
    if (typeof source !== 'string' || !source.trim() || !['folder', 'zip', 'github'].includes(kind))
      throw new Error('Choose a GitHub repository, folder or ZIP file.');
    await this.discard();
    const temp = this.staging;
    await fs.rm(temp, { recursive: true, force: true });
    await fs.mkdir(temp, { mode: 0o700, recursive: true });
    try {
      let directory = path.resolve(source);
      if (kind !== 'folder') {
        const file = kind === 'github' ? path.join(temp, 'download.zip') : directory;
        if (kind === 'github') await download(githubRepository(source), file, fetch, signal);
        directory = path.join(temp, 'files');
        await fs.mkdir(directory);
        await unzip(file, directory).catch(error => {
          if (error.message === 'This skills archive is too large.') throw error;
          throw invalidArchive();
        });
        if (kind === 'github') {
          // Compare repository-relative paths, excluding codeload's enclosing directory.
          const entries = await fs.readdir(directory, { withFileTypes: true });
          if (entries.length === 1 && entries[0].isDirectory() && entries[0].name.endsWith('-HEAD'))
            directory = path.join(directory, entries[0].name);
        }
      } else {
        directory = await fs.realpath(directory);
        if (!(await fs.stat(directory)).isDirectory()) throw new Error('Import a regular skill folder.');
      }
      const candidates: SkillCandidate[] = [];
      await findSkills(directory, candidates);
      signal?.throwIfAborted();
      if (!candidates.length) throw new Error('No skill folders containing SKILL.md were found.');
      this.preview = { directory, candidates, repository: kind === 'github' ? source.trim() : '' };
      return { candidates };
    } catch (error) { await fs.rm(temp, { recursive: true, force: true }); throw error; }
  }
  async import({ id, client, link }: { id: string; client: Client; link?: string }) {
    const preview = this.preview, item = preview?.candidates.find(item => item.id === id);
    const origin = item && preview.repository ? { repository: preview.repository, id } : null;
    if (link !== undefined) {
      if (!origin || item.name !== link) throw new Error('The repository does not contain this installed Skill.');
      const library = path.join(this.library, item.name);
      if ((await metadata(library))?.title !== item.title) throw new Error('The repository does not contain this installed Skill.');
      if (!await readMarker(library)) throw new Error('The selected skill folder is unavailable.');
      atomic(path.join(library, sourceFile), { ...origin, hash: await skillHash(library) });
      return this.list();
    }
    if (!item || !extensionClients.includes(client)) throw new Error('Select a skill and a client.');
    if ((await this.clientCopies(item.name, client)).length) throw new Error('This client already has a skill with that folder name.');
    await this.install(item.name, path.join(preview.directory, item.id), client, origin);
    return this.list();
  }
  async install(name: string, source: string, client: Client, origin?: SkillSource | null) {
    const library = path.join(this.library, name);
    await copySkill(source, library, randomUUID());
    try {
      if (origin) atomic(path.join(library, sourceFile), { ...origin, hash: await skillHash(library) });
      await this.apply(name, client, true);
    }
    catch (error) { await fs.rm(library, { recursive: true, force: true }); throw error; }
  }
  async updateAll({ fetch, signal }: { fetch: UpstreamFetch; signal?: AbortSignal }) {
    const groups = new Map<string, { row: SkillRow; library: string; origin: SkillSource }[]>(), failures = [];
    let updated = 0;
    for (const row of (await this.list()).filter(row => row.updatable)) {
      const library = path.join(this.library, row.name);
      try {
        const origin = await readConfig(path.join(library, sourceFile), JSON.parse);
        const repo = githubRepository(origin.repository).toLowerCase();
        const group = groups.get(repo) || [];
        group.push({ row, library, origin });
        groups.set(repo, group);
      } catch (error) { failures.push({ name: row.title, message: error.message }); }
    }
    for (const skills of groups.values()) {
      signal?.throwIfAborted();
      try {
        const { candidates } = await this.discover({ kind: 'github', source: skills[0].origin.repository, fetch, signal });
        for (const { row, library, origin } of skills) {
          signal?.throwIfAborted();
          try {
            const item = candidates.find(item => item.id === origin.id && item.name === row.name);
            if (!item || item.title !== row.title) throw new Error('The Skill has moved or changed its name in the source repository.');
            const source = path.join(this.preview.directory, item.id);
            const hash = await skillHash(source);
            if (hash === origin.hash) continue;
            const nonce = await readMarker(library);
            if (!nonce) throw new Error('The selected skill folder is unavailable.');
            const targets = new Set([await fs.realpath(library)]);
            for (const folders of Object.values(this.directories)) for (const folder of folders) {
              const copy = path.join(folder, row.name);
              if (await readMarker(copy) === nonce) targets.add(await fs.realpath(copy));
            }
            await replaceSkill(source, [...targets], nonce, origin, hash);
            updated++;
          } catch (error) { failures.push({ name: row.title, message: error.message }); }
        }
      } catch (error) {
        signal?.throwIfAborted();
        for (const { row } of skills) failures.push({ name: row.title, message: error.message });
      } finally { await this.discard(); }
    }
    return { rows: await this.list(), updated, failures };
  }
  async setEnabled(client, copies, enabled) {
    if (client === 'codex') {
      await codexSession(this, async call => {
        const file = path.join(this.codexHome, 'config.toml');
        const read = () => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        const original = await read();
        const { layers } = await call<CodexConfigResult>('config/read', { includeLayers: true });
        const user = layers?.find(layer => layer.name.type === 'user' && !layer.name.profile);
        const paths = new Set();
        const nextRules = [];
        for (const { folder } of copies) {
          const skill = path.join(folder, 'SKILL.md'), real = await fs.realpath(skill);
          paths.add(skill); paths.add(real);
          nextRules.push({ path: real, enabled });
        }
        const rules = (parse(original).skills as { config?: { path?: string; name?: string; enabled?: boolean }[] })?.config || [];
        // A final path rule can override a disabled name rule without altering other Skills.
        const value = [...rules.filter(rule => !paths.has(rule.path)), ...new Map(nextRules.map(rule => [rule.path, rule])).values()];
        if (!user || await read() !== original) throw new Error('Skill settings changed. Refresh and try again.');
        await call('config/batchWrite', { expectedVersion: user.version, edits: [{ keyPath: 'skills.config', value, mergeStrategy: 'replace' }] })
          .catch(() => { throw new Error('Could not update Codex skill settings. Refresh and try again.'); });
      });
    } else {
      const settings = await readConfig(this.claudeConfig, JSON.parse);
      const overrides = Object.assign(Object.create(null), settings.skillOverrides);
      for (const { title } of copies) {
        if (!enabled) overrides[title] = 'off';
        else if (overrides[title] === 'off') delete overrides[title];
      }
      if (JSON.stringify(overrides) === JSON.stringify(settings.skillOverrides || {})) return;
      atomic(this.claudeConfig, { ...settings, skillOverrides: overrides });
    }
  }
  async removeCopy(name, client, nonce) {
    for (const directory of this.directories[client]) {
      const target = path.join(directory, name);
      const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (stat?.isDirectory() && await readMarker(target) === nonce) await fs.rm(target, { recursive: true });
    }
  }
  async apply(name, client, enabled) {
    const library = path.join(this.library, name), nonce = await readMarker(library);
    const directories = this.directories[client], target = path.join(directories[0], name);
    const copies = await this.clientCopies(name, client);
    if (copies.length) {
      await this.setEnabled(client, copies, enabled);
      return;
    }
    if (!enabled) return;
    for (const directory of directories)
      if (await exists(path.join(directory, name))) throw new Error('This client already has a skill with that folder name.');
    if (!nonce) {
      const source = (await this.clientCopies(name, client === 'codex' ? 'claude' : 'codex'))[0];
      if (!source) throw new Error('The selected skill folder is unavailable.');
      return this.install(name, await fs.realpath(source.folder), client);
    }
    await copySkill(library, target, nonce);
    try {
      const installed = (await this.list()).find(row => row.name === name);
      if (!installed?.enabled[client]) await this.setEnabled(client, await this.clientCopies(name, client), true);
    } catch (error) {
      await this.removeCopy(name, client, nonce);
      throw error;
    }
  }
  async change({ operation, name, client, enable }: {
    name: string; client: Client; operation: 'toggle' | 'remove'; enable?: boolean;
  }) {
    if (!validDirectory(name) || !extensionClients.includes(client)) throw new Error('Select a skill and a client.');
    if (operation === 'toggle' && typeof enable === 'boolean') await this.apply(name, client, enable);
    else if (operation === 'remove') {
      const nonce = await readMarker(path.join(this.library, name));
      if (!nonce) throw new Error('The selected skill folder is unavailable.');
      for (const client of extensionClients) await this.removeCopy(name, client, nonce);
      await fs.rm(path.join(this.library, name), { recursive: true });
    } else throw new Error('Unknown skill operation.');
    return this.list();
  }
}
