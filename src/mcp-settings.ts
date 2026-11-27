import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { atomic, type Client } from './store.js';
import { codexSession, type CodexConfigResult } from './sync-codex.js';
import type { CodexExecutable } from './codex-binary.js';

export const extensionClients: readonly Client[] = ['codex', 'claude'];
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function read(file: string, format: (text: string) => unknown = JSON.parse) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { text: null, data: {} }; throw error; }
  try {
    const data = format(text);
    if (object(data)) return { text, data: data as Record<string, unknown> };
  } catch {}
  throw new Error('A local configuration file could not be read. Check its syntax and refresh.');
}

function transport(config) {
  if (config?.url) return config.type === 'sse' ? 'sse' : 'http';
  return config?.command ? 'stdio' : null;
}

function validateConfig(config, client) {
  const type = transport(config);
  if (!object(config) || !type || config.command && config.url ||
      config.type && ![type, ...(type === 'http' ? ['streamable-http'] : [])].includes(config.type))
    throw new Error('Enter a valid MCP command or HTTP URL.');
  if (type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim() || /[\x00\r\n]/.test(config.command) ||
        config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')))
      throw new Error('Enter a valid MCP command and argument list.');
  } else {
    if (client === 'codex' && type === 'sse') throw new Error('Codex requires a Streamable HTTP endpoint for remote MCP servers.');
    let url;
    try { url = new URL(config.url); } catch {}
    if (typeof config.url !== 'string' || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Enter a valid MCP command or HTTP URL.');
  }
  for (const field of ['env', 'headers', 'http_headers', 'env_http_headers']) {
    if (config[field] !== undefined && (!object(config[field]) || Object.values(config[field]).some(value => typeof value !== 'string')))
      throw new Error('MCP environment variables and headers must be string maps.');
  }
  const result = { ...config };
  if (client === 'claude') {
    result.type = type; delete result.enabled;
    if (type !== 'stdio' && config.http_headers) {
      result.headers = { ...config.http_headers, ...config.headers }; delete result.http_headers;
    }
  } else {
    delete result.type; delete result.enabled;
    if (type === 'http' && config.headers) {
      result.http_headers = { ...config.headers, ...config.http_headers }; delete result.headers;
    }
  }
  return result;
}

function convert(config, client) {
  const type = transport(config);
  if (type === 'stdio') {
    if (config.cwd || config.env_vars?.length || client === 'codex' &&
        [config.command, ...(config.args || []), ...Object.values(config.env || {})].some(value => String(value).includes('${')))
      throw new Error('This MCP configuration needs client-specific command settings.');
    return validateConfig({ command: config.command, ...(config.args && { args: config.args }), ...(config.env && { env: config.env }) }, client);
  }
  if (!type) throw new Error('Enter a valid MCP command or HTTP URL.');
  if (config.headersHelper || config.http_headers_helper) throw new Error('This MCP configuration needs client-specific headers.');
  const headers = { ...(config.http_headers || config.headers) };
  const variables = {};
  let bearer;
  if (client === 'claude') {
    for (const [name, variable] of Object.entries(config.env_http_headers || {})) headers[name] = '${' + variable + '}';
    if (config.bearer_token_env_var) headers.Authorization = 'Bearer ${' + config.bearer_token_env_var + '}';
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') throw new Error('MCP environment variables and headers must be string maps.');
      const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
      const token = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i.exec(value)?.[1];
      if (variable) { variables[name] = variable; delete headers[name]; }
      else if (token && name.toLowerCase() === 'authorization') { bearer = token; delete headers[name]; }
      else if (value.includes('${')) throw new Error('This MCP configuration needs client-specific headers.');
    }
  }
  return validateConfig({ type, url: config.url,
    ...(Object.keys(headers).length && { [client === 'claude' ? 'headers' : 'http_headers']: headers }),
    ...(Object.keys(variables).length && { env_http_headers: variables }),
    ...(bearer && { bearer_token_env_var: bearer }),
  }, client);
}

export function parseMcpEntry(text: string, name: string, client: Client) {
  if (!extensionClients.includes(client) || typeof text !== 'string' || text.length > 128 * 1024)
    throw new Error('Enter a valid MCP configuration.');
  let config;
  try { config = JSON.parse(text); } catch {
    try { config = parse(text); } catch { throw new Error('Paste a valid JSON or TOML MCP configuration.'); }
  }
  const servers = config?.mcpServers || config?.mcp_servers;
  if (servers) {
    const names = Object.keys(servers);
    name ||= names.length === 1 ? names[0] : '';
    if (!object(servers) || !Object.hasOwn(servers, name)) throw new Error('Enter the name of a single MCP server in the pasted configuration.');
    const original = config.mcpServers ? 'claude' : 'codex';
    config = original === client ? servers[name] : convert(servers[name], client);
  } else if (client === 'codex' && (config?.headers || config?.type === 'sse') || client === 'claude' && (config?.env_http_headers || config?.bearer_token_env_var)) {
    config = convert(config, client);
  }
  if (!validName(name)) throw new Error('Use letters, digits, hyphens or underscores for the MCP server name.');
  return { name, config: validateConfig(config, client) };
}

export class McpSettings {
  declare codexHome: string;
  declare binary: CodexExecutable;
  declare files: Record<Client | 'disabled', string>;
  declare writing?: boolean;

  constructor({ root, codexHome, binary, env = process.env, userHome = os.homedir() }) {
    Object.assign(this, { codexHome, binary });
    this.files = {
      codex: path.join(codexHome, 'config.toml'),
      claude: path.resolve(env.CLAUDE_CONFIG_DIR || userHome, '.claude.json'),
      disabled: path.join(root, 'mcp-disabled.json'),
    };
  }
  read() {
    const codex = read(this.files.codex, parse);
    const claude = read(this.files.claude);
    const disabled = read(this.files.disabled).data;
    const live = { codex: codex.data.mcp_servers || {}, claude: claude.data.mcpServers || {} };
    if (Object.values(live).some(value => !object(value))) throw new Error('A local configuration file could not be read. Check its syntax and refresh.');
    return { codex, claude, disabled, live };
  }
  live(state, name, client) { return Object.hasOwn(state.live[client], name) ? state.live[client][name] : null; }
  own(state, name, client) {
    const saved = state.disabled[client];
    return this.live(state, name, client) || (saved && Object.hasOwn(saved, name) ? saved[name] : null);
  }
  list() {
    const state = this.read(), names = new Set<string>();
    for (const client of extensionClients) {
      for (const name of [...Object.keys(state.live[client]), ...Object.keys(state.disabled[client] || {})]) if (validName(name)) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b)).map(name => {
      const available = Object.fromEntries(extensionClients.map(client => [client, !!this.own(state, name, client)]));
      const enabled = Object.fromEntries(extensionClients.map(client => {
        const config = this.live(state, name, client);
        return [client, !!config && (client === 'claude' || config.enabled !== false)];
      }));
      const types = [...new Set(extensionClients.map(client => transport(this.own(state, name, client))).filter(Boolean))];
      return { name, available, enabled, types };
    });
  }
  details({ name, client }: { name: string; client: Client }) {
    if (!validName(name) || !extensionClients.includes(client)) throw new Error('Unknown MCP server.');
    const state = this.read();
    const config = this.own(state, name, client);
    if (!config) throw new Error('Unknown MCP server.');
    return { config: JSON.parse(JSON.stringify(config)), enabled: !!this.live(state, name, client) && (client === 'claude' || config.enabled !== false) };
  }
  async writeNative(state, client, name, value, field = '') {
    if (client === 'claude') {
      if (read(this.files.claude).text !== state.claude.text) throw new Error('MCP configuration changed. Refresh and try again.');
      const servers = { ...state.live.claude };
      if (value) servers[name] = value; else delete servers[name];
      atomic(this.files.claude, { ...state.claude.data, mcpServers: servers });
      return;
    }
    await codexSession(this, async call => {
      const { layers } = await call<CodexConfigResult>('config/read', { includeLayers: true });
      const user = layers?.find(layer => layer.name.type === 'user' && !layer.name.profile);
      if (!user || read(this.files.codex, parse).text !== state.codex.text) throw new Error('MCP configuration changed. Refresh and try again.');
      await call('config/batchWrite', { expectedVersion: user.version, edits: [{ keyPath: 'mcp_servers.' + name + field, value, mergeStrategy: 'replace' }] })
        .catch(() => { throw new Error('Could not update Codex MCP configuration. Refresh and try again.'); });
    });
  }
  async change({ name, client, operation, text, enable, expected }: {
    name: string; client: Client; operation: 'add' | 'edit' | 'remove' | 'toggle'; text?: string; enable?: boolean; expected?: unknown;
  }) {
    if (this.writing) throw new Error('MCP configuration changed. Refresh and try again.');
    if (!extensionClients.includes(client)) throw new Error('Select an MCP client.');
    this.writing = true;
    try {
      const state = this.read();
      let value;
      if (operation === 'add' || operation === 'edit') ({ name, config: value } = parseMcpEntry(text, name, client));
      if (!validName(name)) throw new Error('Unknown MCP server.');
      const own = this.own(state, name, client), live = this.live(state, name, client);
      const setDisabled = value => {
        const saved = (state.disabled[client] ||= {}) as Record<string, unknown>;
        if (value) saved[name] = value; else if (Object.hasOwn(saved, name)) delete saved[name]; else return;
        atomic(this.files.disabled, state.disabled);
      };
      if (operation === 'add') {
        if (own) throw new Error('This client already has an MCP server with that name.');
        await this.writeNative(state, client, name, value);
      } else if (operation === 'edit') {
        if (!own || !isDeepStrictEqual(JSON.parse(JSON.stringify(own)), expected)) throw new Error('MCP configuration changed. Refresh and try again.');
        if (!live) setDisabled(value);
        else await this.writeNative(state, client, name, live.enabled === false && client === 'codex' ? { ...value, enabled: false } : value);
      } else if (operation === 'toggle' && typeof enable === 'boolean') {
        if (client === 'codex' && live) {
          if ((live.enabled !== false) !== enable) await this.writeNative(state, client, name, enable ? null : false, '.enabled');
        } else if (enable && !live) {
          const other = client === 'codex' ? 'claude' : 'codex';
          const source = this.own(state, name, other);
          if (!own && !source) throw new Error('Unknown MCP server.');
          await this.writeNative(state, client, name, own || convert(source, client));
          setDisabled(null);
        } else if (!enable && live) {
          setDisabled(live);
          await this.writeNative(state, client, name, null);
        }
      } else if (operation === 'remove') {
        if (!own || !isDeepStrictEqual(JSON.parse(JSON.stringify(own)), expected)) throw new Error('MCP configuration changed. Refresh and try again.');
        if (live) await this.writeNative(state, client, name, null);
        setDisabled(null);
      } else throw new Error('Unknown MCP operation.');
      return this.list();
    } finally { this.writing = false; }
  }
}
