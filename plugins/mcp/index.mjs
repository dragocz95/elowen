// MCP bridge plugin: connect external Model Context Protocol servers (stdio / HTTP / SSE) and expose
// their tools as native brain tools. stdio servers are spawned in their OWN process group so cleanup
// can kill the entire group — reaping npx grandchildren that a plain child.kill() would orphan.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { spawn } from 'node:child_process';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ok: true, ...details } });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`, {
  ok: false,
  error: { message: e instanceof Error ? e.message : String(e) },
});

const CONNECT_TIMEOUT_MS = 15_000; // default; overridable via config.connectTimeoutMs (global, all servers)
const CALL_TIMEOUT_MS = 120_000; // default; overridable via config.callTimeoutMs (global, all servers)

/** Read a numeric config override, clamped to [min, max]; falls back to `def` when unset/invalid. */
function configNumber(value, def, min, max) {
  return Math.min(Math.max(Number(value) || def, min), max);
}

const INSTANCE_OWNER = null;
const serverKey = (ownerUserId, name) => `${ownerUserId == null ? 'instance' : `user:${ownerUserId}`}:${name}`;
const ownerScope = (ownerUserId) => ownerUserId == null ? 'instance' : 'personal';

function initStore(ctx) {
  const db = ctx.db();
  db.migrate([{
    version: 1,
    up(m) {
      m.exec(`
        CREATE TABLE IF NOT EXISTS p_mcp_servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          tools_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS p_mcp_servers_instance_name
          ON p_mcp_servers(name) WHERE owner_user_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS p_mcp_servers_user_name
          ON p_mcp_servers(owner_user_id, name) WHERE owner_user_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS p_mcp_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  }, {
    version: 2,
    up(m) { m.exec('ALTER TABLE p_mcp_servers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0'); },
  }]);
  const imported = db.prepare('SELECT value FROM p_mcp_meta WHERE key = ?').get('legacy_config_imported');
  if (!imported) {
    db.transaction(() => {
      const insert = db.prepare(`INSERT OR IGNORE INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json)
        VALUES (?, ?, ?, '[]')`);
      for (const raw of Array.isArray(ctx.config?.servers) ? ctx.config.servers : []) {
        if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) continue;
        const spec = { ...raw, name: raw.name.trim(), enabled: raw.enabled !== false };
        insert.run(INSTANCE_OWNER, spec.name, JSON.stringify(spec));
      }
      db.prepare('INSERT INTO p_mcp_meta (key, value) VALUES (?, ?)').run('legacy_config_imported', '1');
    });
  }
  return db;
}

function parseJsonObject(value) {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

function parseJsonArray(value) {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function loadStoredSpecs(db) {
  const rows = db.prepare('SELECT owner_user_id, name, spec_json, tools_json, revision FROM p_mcp_servers ORDER BY owner_user_id IS NOT NULL, owner_user_id, name').all();
  const specs = [];
  for (const row of rows) {
    const spec = parseJsonObject(row.spec_json);
    if (!spec || typeof row.name !== 'string') continue;
    const cachedBridged = parseJsonArray(row.tools_json);
    specs.push({ ...spec, name: row.name, enabled: spec.enabled !== false, ownerUserId: row.owner_user_id == null ? null : Number(row.owner_user_id), cachedBridged, revision: Number.isSafeInteger(row.revision) ? row.revision : 0 });
  }
  return specs;
}

function persistTools(db, spec, tools) {
  const sql = spec.ownerUserId == null
    ? 'UPDATE p_mcp_servers SET tools_json = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id IS NULL AND name = ?'
    : 'UPDATE p_mcp_servers SET tools_json = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND name = ?';
  const params = spec.ownerUserId == null
    ? [JSON.stringify(tools), spec.name]
    : [JSON.stringify(tools), spec.ownerUserId, spec.name];
  db.prepare(sql).run(...params);
}

// An INSTANCE server is not a tool the caller may be granted — it is an ownerless shared resource that
// runs for everybody at instance authority. A plugin grant cannot express that, and if it tried, any
// granted account could create something running beyond its own permissions. So this stays an
// administrator decision on purpose: it is an invariant about ownerless objects, not a leftover gate
// from before permissions were unified. A PERSONAL server needs only an account, and runs as that account.
function ownerForScope(ctx, scope) {
  const identity = ctx.currentIdentity();
  if (scope === 'instance') {
    if (identity?.owner !== true) throw new Error('instance MCP servers can be managed only by administrators of this instance');
    return null;
  }
  if (scope === 'personal') {
    if (identity?.elowenUserId == null) throw new Error('personal MCP servers require a linked Elowen account');
    return identity.elowenUserId;
  }
  throw new Error('scope must be personal or instance');
}

function specForOwner(ownerUserId, name) {
  return state.specs.find((spec) => spec.ownerUserId === ownerUserId && spec.name === name);
}

/** A stdio server is arbitrary local process execution, regardless of whether its row is labelled
 * personal or instance. Only an administrator of this instance may create or start one. Remote HTTP/SSE
 * servers do not execute a caller-supplied command on this host, so a linked account may keep those personal.
 *
 * This is the same authority a shell needs, and the shell is now handed out by granting `terminal`. The
 * obvious next step — accept a terminal grant here too — is deliberately NOT taken: a plugin cannot read
 * another plugin's grant, and inventing a cross-plugin grant API for one gate would buy a coupling far
 * more expensive than the gate. An administrator who wants to give somebody local process execution
 * grants them `terminal`, which is a strictly more capable and more visible way to say the same thing. */
function assertTransportAuthority(ctx, spec) {
  if (transportKind(spec) === 'stdio' && ctx.currentIdentity()?.owner !== true) {
    throw new Error('local-process MCP servers can be managed only by administrators of this instance');
  }
}

const SENSITIVE_URL_PARAMETER = /^(?:api[_-]?key|auth|authorization|access[_-]?token|password|secret|token)$/i;

export function validateServerInput(input) {
  const name = String(input?.name ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) throw new Error('server name must be 1-40 letters, numbers, underscores or dashes');
  const transport = input?.transport ?? (input?.url ? 'http' : 'stdio');
  if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error('transport must be stdio, http or sse');
  if (transport === 'stdio') {
    const command = String(input?.command ?? '').trim();
    if (!command) throw new Error('stdio MCP servers require command');
    return {
      name, enabled: input?.enabled !== false, transport, command,
      args: Array.isArray(input?.args) ? input.args.map(String) : [],
      ...(input?.env && typeof input.env === 'object' && !Array.isArray(input.env)
        ? { env: Object.fromEntries(Object.entries(input.env).map(([key, value]) => [key, String(value)])) }
        : {}),
    };
  }
  const url = String(input?.url ?? '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${transport} MCP servers require a valid URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MCP server URL must use http or https');
  if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => SENSITIVE_URL_PARAMETER.test(key))) {
    throw new Error('MCP server URLs must not contain credentials or secret query parameters');
  }
  return { name, enabled: input?.enabled !== false, transport, url: parsed.toString() };
}

async function closeLiveSpec(spec) {
  const key = serverKey(spec.ownerUserId, spec.name);
  const entries = state.live.filter((entry) => entry.key === key);
  for (const entry of entries) {
    entry.closing = true;
    const at = state.live.indexOf(entry);
    if (at >= 0) state.live.splice(at, 1);
    try { await entry.transport?.close?.(); } catch { /* already closed */ }
    killTree(entry.child);
    try { await entry.client?.close?.(); } catch { /* already closed */ }
  }
  state.connecting.delete(key);
}

async function addMcpServerForScope(ctx, scope, input) {
  const ownerUserId = ownerForScope(ctx, scope);
  const spec = { ...validateServerInput(input), ownerUserId, cachedBridged: [] };
  assertTransportAuthority(ctx, spec);
  if (state.specs.some((candidate) => candidate.name === spec.name
    && (candidate.ownerUserId == null || candidate.ownerUserId === ownerUserId))) {
    throw new Error(`MCP server "${spec.name}" already exists in this account's visible scope`);
  }
  state.db.prepare('INSERT INTO p_mcp_servers (owner_user_id, name, spec_json, tools_json) VALUES (?, ?, ?, ?)')
    .run(ownerUserId, spec.name, JSON.stringify({ ...spec, ownerUserId: undefined, cachedBridged: undefined }), '[]');
  state.specs.push(spec);
  setServerState(spec, { status: spec.enabled ? 'disconnected' : 'disabled', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  try {
    if (spec.enabled) {
      await connectServer(ctx, spec, state.live);
      if (ownerUserId != null) await closeLiveSpec(spec);
    }
    ctx.requestReload();
    return publicServerState(spec);
  } catch (error) {
    await closeLiveSpec(spec);
    state.specs.splice(state.specs.indexOf(spec), 1);
    state.servers.delete(serverKey(ownerUserId, spec.name));
    const sql = ownerUserId == null
      ? 'DELETE FROM p_mcp_servers WHERE owner_user_id IS NULL AND name = ?'
      : 'DELETE FROM p_mcp_servers WHERE owner_user_id = ? AND name = ?';
    state.db.prepare(sql).run(...(ownerUserId == null ? [spec.name] : [ownerUserId, spec.name]));
    throw error;
  }
}

async function removeMcpServerForScope(ctx, scope, name) {
  const ownerUserId = ownerForScope(ctx, scope);
  const spec = specForOwner(ownerUserId, String(name ?? '').trim());
  if (!spec) throw new Error(`unknown ${scope} MCP server "${name}"`);
  await closeLiveSpec(spec);
  const sql = ownerUserId == null
    ? 'DELETE FROM p_mcp_servers WHERE owner_user_id IS NULL AND name = ?'
    : 'DELETE FROM p_mcp_servers WHERE owner_user_id = ? AND name = ?';
  state.db.prepare(sql).run(...(ownerUserId == null ? [spec.name] : [ownerUserId, spec.name]));
  state.specs.splice(state.specs.indexOf(spec), 1);
  state.servers.delete(serverKey(ownerUserId, spec.name));
  ctx.requestReload();
  return { removed: true, name: spec.name, scope };
}

async function reconnectMcpServerForScope(ctx, scope, name) {
  const ownerUserId = ownerForScope(ctx, scope);
  const spec = specForOwner(ownerUserId, String(name ?? '').trim());
  if (!spec) throw new Error(`unknown ${scope} MCP server "${name}"`);
  if (!spec.enabled) throw new Error(`MCP server "${name}" is disabled`);
  await closeLiveSpec(spec);
  const tools = await connectServer(ctx, spec, state.live);
  if (ownerUserId != null) await closeLiveSpec(spec);
  if (tools.length) registerBridgedTools(ctx, ownerUserId == null ? connectedClient(state.live) : lazyClient(ctx, state.live), [{ spec, tools }]);
  ctx.requestReload();
  return publicServerState(spec);
}

function redactUrl(value) {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch { return undefined; }
}

function editableServer(spec) {
  return {
    ...publicServerState(spec),
    revision: spec.revision ?? 0,
    enabled: spec.enabled,
    ...(transportKind(spec) === 'stdio'
      ? { command: spec.command, args: spec.args ?? [], envKeys: Object.keys(spec.env ?? {}) }
      : { url: redactUrl(spec.url) }),
  };
}

async function updateMcpServerForScope(ctx, scope, name, input) {
  const ownerUserId = ownerForScope(ctx, scope);
  const spec = specForOwner(ownerUserId, String(name ?? '').trim());
  if (!spec) throw new Error(`unknown ${scope} MCP server "${name}"`);
  const expectedRevision = input?.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error('expectedRevision must be a non-negative integer');
  }
  if (expectedRevision !== undefined && expectedRevision !== (spec.revision ?? 0)) {
    const error = new Error('MCP server changed on the server; reload it before saving');
    error.status = 409;
    error.conflict = true;
    error.current = editableServer(spec);
    throw error;
  }
  const previous = { ...spec, args: [...(spec.args ?? [])], env: { ...(spec.env ?? {}) }, cachedBridged: [...(spec.cachedBridged ?? [])] };
  const next = { ...validateServerInput({ ...spec, ...input, name: spec.name }), ownerUserId, cachedBridged: [], revision: (spec.revision ?? 0) + 1 };
  assertTransportAuthority(ctx, next);
  await closeLiveSpec(spec);
  Object.assign(spec, next);
  const sql = ownerUserId == null
    ? 'UPDATE p_mcp_servers SET spec_json = ?, tools_json = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id IS NULL AND name = ?'
    : 'UPDATE p_mcp_servers SET spec_json = ?, tools_json = ?, revision = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND name = ?';
  const stored = JSON.stringify({ ...next, ownerUserId: undefined, cachedBridged: undefined });
  state.db.prepare(sql).run(...(ownerUserId == null ? [stored, '[]', next.revision, spec.name] : [stored, '[]', next.revision, ownerUserId, spec.name]));
  try {
    if (spec.enabled) {
      await connectServer(ctx, spec, state.live);
      if (ownerUserId != null) await closeLiveSpec(spec);
    } else {
      setServerState(spec, { status: 'disabled', lastError: null, tools: [], toolCount: 0, bridged: [] });
    }
    ctx.requestReload();
    return editableServer(spec);
  } catch (error) {
    await closeLiveSpec(spec);
    Object.assign(spec, previous);
    const oldStored = JSON.stringify({ ...previous, ownerUserId: undefined, cachedBridged: undefined });
    state.db.prepare(sql).run(...(ownerUserId == null
      ? [oldStored, JSON.stringify(previous.cachedBridged), previous.revision ?? 0, spec.name]
      : [oldStored, JSON.stringify(previous.cachedBridged), previous.revision ?? 0, ownerUserId, spec.name]));
    setServerState(spec, { status: 'disconnected', lastError: null, tools: [], toolCount: previous.cachedBridged.length, bridged: previous.cachedBridged });
    throw error;
  }
}

/** Move a server between the instance set and the caller's OWN personal set. Both ends resolve through
 *  `ownerForScope`, so this cannot place a server in a scope AddMcpServer would refuse — and because
 *  'personal' resolves to the caller, a server is only ever taken to or from the acting account. There is
 *  deliberately no way to hand one to a third party: that would need an authority check on somebody who
 *  is not making the request.
 *
 *  stdio is refused outright, and that is the whole reason this is safe. Whether a local process may run
 *  is authority the DESTINATION owner needs to hold, and this plugin cannot ask — it declares
 *  `reads: ['db']`, so it has no view of accounts, while `assertTransportAuthority` reads the CALLER,
 *  which is the wrong person the moment a server changes hands. Moving one would also hand the
 *  destination the stored `env`, which `editableServer` returns to whoever owns the row. So stdio stays
 *  what its own comment already says it is: an administrator's local-process decision, delegated by
 *  granting `terminal`, never by moving a row. */
async function moveMcpServerScope(ctx, fromScope, name, toScope, expectedRevision) {
  const fromOwner = ownerForScope(ctx, fromScope);
  const toOwner = ownerForScope(ctx, toScope);
  if (fromOwner === toOwner) throw new Error('the MCP server already belongs to that scope');
  const spec = specForOwner(fromOwner, String(name ?? '').trim());
  if (!spec) throw new Error(`unknown ${fromScope} MCP server "${name}"`);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error('expectedRevision must be a non-negative integer');
  }
  if (expectedRevision !== undefined && expectedRevision !== (spec.revision ?? 0)) {
    const error = new Error('MCP server changed on the server; reload it before saving');
    error.status = 409;
    error.conflict = true;
    error.current = editableServer(spec);
    throw error;
  }
  if (transportKind(spec) === 'stdio') {
    throw new Error('local-process MCP servers cannot change scope — create the server again in the target scope instead');
  }
  // The visibility rule AddMcpServer applies, minus the server being moved: the name must not collide
  // with the instance set, nor with the destination account's own servers.
  if (state.specs.some((candidate) => candidate !== spec && candidate.name === spec.name
    && (candidate.ownerUserId == null || candidate.ownerUserId === toOwner))) {
    throw new Error(`MCP server "${spec.name}" already exists in that scope`);
  }
  // Tear down FIRST. Every runtime map — live, servers, connecting, reconnecting — is keyed by
  // serverKey(ownerUserId, name), so a connection closed after the owner changed would be looked up
  // under a key it was never stored with: the transport would leak, and for a spawned server so would
  // its process group.
  await closeLiveSpec(spec);
  const previousOwner = spec.ownerUserId;
  const previousKey = serverKey(previousOwner, spec.name);
  const sql = previousOwner == null
    ? 'UPDATE p_mcp_servers SET owner_user_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id IS NULL AND name = ?'
    : 'UPDATE p_mcp_servers SET owner_user_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND name = ?';
  state.db.prepare(sql).run(...(previousOwner == null ? [toOwner, spec.name] : [toOwner, previousOwner, spec.name]));
  // The cached tool list is kept on purpose: the SPECIFICATION did not change, so what the server last
  // advertised is still what it advertises — and a personal server composes its tools from that cache
  // without connecting at all.
  spec.ownerUserId = toOwner;
  spec.revision = (spec.revision ?? 0) + 1;
  state.servers.delete(previousKey);
  setServerState(spec, { status: spec.enabled ? 'disconnected' : 'disabled', transport: transportKind(spec), lastError: null });
  // An instance server is expected to be LIVE; a personal one connects lazily on first use, which is
  // exactly the state AddMcpServer leaves it in. A failed connect is reported in the server's own state
  // rather than rolled back: this specification was already verified when it was created, so a server
  // that is unreachable right now is no evidence that the move was wrong.
  if (toOwner == null && spec.enabled) {
    try {
      const tools = await connectServer(ctx, spec, state.live);
      if (tools.length) registerBridgedTools(ctx, connectedClient(state.live), [{ spec, tools }]);
    } catch (error) {
      ctx.logger?.warn?.(`mcp: moved "${spec.name}" to the instance scope but could not connect it: ${error instanceof Error ? error.message : error}`);
    }
  }
  ctx.requestReload();
  return editableServer(spec);
}

const state = {
  ctx: null,
  db: null,
  specs: [],
  live: [],
  reconnecting: new Set(),
  servers: new Map(),
  /** serverName → the in-flight LAZY connect for it. Single-flight: two bridged tools of the same server
   *  called in the same turn must share ONE connect, or a first parallel call would launch two server
   *  process trees and leave one of them orphaned in `live`. Only ever populated in a sub-agent runner. */
  connecting: new Map(),
};

/** Whether an MCP error means the server simply doesn't implement the method (no `resources` capability),
 *  as opposed to a real failure (timeout, transport error) we must not swallow. JSON-RPC code -32601. */
function isMethodNotFound(e) {
  const code = e && typeof e === 'object' ? e.code : undefined;
  if (code === -32601 || code === -32602) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /method not found|not supported|not implemented|-32601/i.test(msg);
}

/** Sanitize a name fragment into a tool-name-safe token. */
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

/** Reject `promise` if it doesn't settle within `ms` (so one wedged server can't hang the whole reload). */
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); timer.unref?.(); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** SIGKILL a detached child's WHOLE process group (pgid === pid, because we spawned it detached), so an
 *  npx wrapper's real server grandchild dies with it. Falls back to a plain kill if the group is gone. */
function killTree(child) {
  if (!child || child.pid == null) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/** A minimal MCP stdio transport over a process WE spawned (detached, own group). Framing is the MCP
 *  stdio spec — one JSON-RPC message per line — reusing the SDK's ReadBuffer/serializeMessage so it stays
 *  byte-compatible with any server. We spawn ourselves (instead of StdioClientTransport) purely to own the
 *  process group for group-kill cleanup. */
class DetachedStdioTransport {
  constructor(child) { this.child = child; this._read = new ReadBuffer(); this._closed = false; }
  async start() {
    this.child.stdout.on('data', (chunk) => {
      this._read.append(chunk);
      try { let m; while ((m = this._read.readMessage()) !== null) this.onmessage?.(m); }
      catch (e) { this.onerror?.(e); }
    });
    this.child.stdout.on('error', (e) => this.onerror?.(e));
    this.child.on('error', (e) => this.onerror?.(e));
    this.child.on('exit', () => { if (!this._closed) { this._closed = true; this.onclose?.(); } });
  }
  async send(message) { this.child.stdin.write(serializeMessage(message)); }
  async close() { this._closed = true; killTree(this.child); this.onclose?.(); }
}

/** Build the client transport for a server spec. stdio spawns a detached child (own process group);
 *  http/sse connect to a remote URL. Returns `{ transport, child }` (child null for remote transports). */
function makeTransport(spec) {
  const kind = spec.transport ?? (spec.url ? 'http' : 'stdio');
  if (kind === 'http') return { transport: new StreamableHTTPClientTransport(new URL(spec.url)), child: null };
  if (kind === 'sse') return { transport: new SSEClientTransport(new URL(spec.url)), child: null };
  const env = { ...process.env, ...(spec.env ?? {}) };
  // detached:true → the child leads a new process group (pgid === child.pid); stderr inherited so a
  // server's own logs surface in the daemon journal.
  const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], { detached: true, env, stdio: ['pipe', 'pipe', 'inherit'] });
  return { transport: new DetachedStdioTransport(child), child };
}

function transportKind(spec) {
  return spec.transport ?? (spec.url ? 'http' : 'stdio');
}

function publicServerState(spec) {
  const key = serverKey(spec.ownerUserId, spec.name);
  const entry = state.servers.get(key) ?? {};
  return {
    name: spec.name,
    scope: ownerScope(spec.ownerUserId),
    transport: transportKind(spec),
    status: entry.status ?? (spec.enabled ? 'disconnected' : 'disabled'),
    tools: entry.tools ?? (spec.cachedBridged ?? []).map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description ?? '',
      schema: tool.inputSchema ?? null,
    })),
    toolCount: entry.toolCount ?? spec.cachedBridged?.length ?? 0,
    lastError: entry.lastError ?? null,
    reconnecting: state.reconnecting.has(key),
  };
}

function setServerState(spec, patch) {
  const key = serverKey(spec.ownerUserId, spec.name);
  const prev = state.servers.get(key) ?? {};
  state.servers.set(key, { ...prev, ...patch, updatedAt: new Date().toISOString() });
}

/** Image mime types the brain can embed inline as real image blocks (same set as the files plugin). */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Map an MCP tool-call result into the brain tool-result shape. Image parts become REAL image blocks
 *  (so a vision model actually sees a screenshot, and history stripping can placeholder them later);
 *  anything else non-text collapses to a short placeholder — never a stringified base64 payload. */
function mapResult(res) {
  const parts = Array.isArray(res?.content) ? res.content : [];
  const content = parts.map((p) => {
    if (p?.type === 'text') return { type: 'text', text: String(p.text ?? '') };
    if (p?.type === 'image' && typeof p.data === 'string' && INLINE_IMAGE_TYPES.has(p.mimeType)) {
      return { type: 'image', data: p.data, mimeType: p.mimeType };
    }
    return { type: 'text', text: `[${typeof p?.type === 'string' ? p.type : 'unknown'} content omitted]` };
  });
  if (!content.length) content.push({ type: 'text', text: res?.isError ? 'MCP tool returned an error.' : '(no output)' });
  return { content, details: { ok: !res?.isError, isError: !!res?.isError } };
}

/** Register one remote MCP tool as a native brain tool (namespaced `mcp__<server>__<tool>`).
 *  Double separators on purpose: a sanitized server or tool name may itself contain `_`, so the old
 *  single-underscore form could not be split back apart unambiguously.
 *  NOTE: the `mcp__` prefix is the deferred-tool-loading contract — src/brain/toolSearch/deferralPolicy.ts
 *  (`MCP_TOOL_PREFIX`) keys deferral off exactly this literal. Keep the two in sync; a drift would silently
 *  stop ToolSearch from ever deferring MCP tools. A test guards the prefix (deferralPolicy.test.ts). */
/** `getClient` is resolved INSIDE execute, never at registration: a tool must be DECLARED to the model,
 *  but the server behind it only has to exist when the tool is CALLED. That asymmetry is what lets a
 *  forked sub-agent runner register the daemon's whole bridged tool set from a snapshot and connect
 *  nothing (see the `snapshot` branch in register()). */
function registerBridgedTool(ctx, getClient, spec, tool) {
  const name = `mcp__${sanitize(spec.name)}__${sanitize(tool.name)}`;
  const params = tool.inputSchema && typeof tool.inputSchema === 'object' ? Type.Unsafe(tool.inputSchema) : Type.Object({});
  ctx.registerTool(defineTool({
    name,
    label: tool.title || tool.name,
    description: `[${spec.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
    parameters: params,
    execute: async (_id, args) => {
      try {
        const callTimeoutMs = configNumber(ctx.config?.callTimeoutMs, CALL_TIMEOUT_MS, 30000, 300000);
        // A connect that fails here surfaces through the same `fail(e)` a call against a dead client
        // does — an error result the model can read, never a crash and never a silent empty answer.
        const client = await getClient();
        const res = await withTimeout(client.callTool({ name: tool.name, arguments: args ?? {} }), callTimeoutMs, `mcp call ${tool.name}`);
        return mapResult(res);
      } catch (e) { return fail(e); }
    },
  }), {
    ...(spec.ownerUserId == null ? {} : { ownerUserId: spec.ownerUserId }),
    ...(transportKind(spec) === 'stdio' ? { hostFilesystem: true } : {}),
  });
}

/** Register bridged tools for several servers in ONE deterministic order. Tool order is part of the
 *  cached prompt prefix, so it must not depend on which server's listTools() answered first — collect
 *  from every server, sort by the final namespaced tool name (locale-independent), then register.
 *
 *  `resolveClient(serverName)` returns how THAT server's client is obtained at call time, or undefined to
 *  skip the server entirely. It is the ONE thing that differs between a connected load and a snapshot
 *  load — everything below (naming, sorting, registration) is shared, so the two cannot produce different
 *  tool lists. */
function registerBridgedTools(ctx, resolveClient, perServer) {
  const pairs = [];
  for (const { spec, tools } of perServer) {
    const getClient = resolveClient(spec);
    if (!getClient) continue;
    for (const tool of tools) pairs.push({ getClient, spec, tool });
  }
  pairs.sort((a, b) => {
    const an = `${a.spec.ownerUserId ?? -1}:mcp__${sanitize(a.spec.name)}__${sanitize(a.tool.name)}`;
    const bn = `${b.spec.ownerUserId ?? -1}:mcp__${sanitize(b.spec.name)}__${sanitize(b.tool.name)}`;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const p of pairs) registerBridgedTool(ctx, p.getClient, p.spec, p.tool);
}

/** The ALREADY-CONNECTED resolver: bind the live client at registration, exactly as this plugin always
 *  did. A server that is not live is skipped, and a client that later dies stays bound and dead until the
 *  operator reconnects it — deliberately, because that is the daemon's existing behaviour and this change
 *  must not alter it. */
const connectedClient = (live) => (spec) => {
  const key = serverKey(spec.ownerUserId, spec.name);
  const client = live.find((e) => e.key === key)?.client;
  return client ? () => Promise.resolve(client) : undefined;
};

/** The LAZY resolver, used for personal servers and in a snapshot-backed runner: connect on the first call
 * to one of this server's tools, and let every concurrent first call share that one connect. */
const lazyClient = (ctx, live) => (spec) => () => connectLazily(ctx, spec, live);

/** Connect one server on demand, SINGLE-FLIGHT: concurrent callers share one promise, so two bridged
 *  tools of the same server called in parallel produce one connect and one server process, and every
 *  caller settles on that connect's own outcome.
 *
 *  It is what makes "one connect" true BY CONSTRUCTION rather than by an accident of timing. Today the
 *  `live.push` inside connectServer happens before its first await, so a second caller would find the
 *  entry anyway — but that is a property of where the awaits currently sit, not of the design, and the day
 *  connectServer gains an await before that push (a config read, a resolver, a lock) the accident stops
 *  holding and two servers get launched with nothing to notice it. */
function connectLazily(ctx, spec, live) {
  // The IN-FLIGHT connect is consulted BEFORE `live`, because connectServer pushes its entry into `live`
  // synchronously and only then connects: between those two moments the entry exists but the connection
  // does not, and connectServer splices it back out if the connect fails. A caller reading `live` first
  // would therefore be handed a client that is mid-handshake — or one about to be abandoned, whose call
  // then waits out the full 120 s call timeout instead of failing with the connect's own error.
  const key = serverKey(spec.ownerUserId, spec.name);
  const inflight = state.connecting.get(key);
  if (inflight) return inflight;
  const entry = live.find((e) => e.key === key);
  if (entry) return Promise.resolve(entry.client);
  if (!state.specs.some((s) => serverKey(s.ownerUserId, s.name) === key)) return Promise.reject(new Error(`unknown MCP server "${spec.name}"`));
  if (!spec.enabled) return Promise.reject(new Error(`MCP server "${spec.name}" is disabled`));
  const pending = connectServer(ctx, spec, live).then(() => {
    const connected = live.find((e) => e.key === key);
    // connectServer pushes its entry into `live` before connecting and splices it back out on failure, so a
    // fulfilled connect with nothing live means the transport closed between the two — treat it as the
    // failure it is rather than handing the caller an undefined client.
    if (!connected) throw new Error(`MCP server "${spec.name}" closed immediately after connecting`);
    return connected.client;
  });
  state.connecting.set(key, pending);
  // Clear the slot once it settles, so a FAILED connect is retried on the next call instead of caching the
  // rejection forever. Guarded on identity: a later attempt may already own the slot by then.
  void pending.catch(() => {}).finally(() => {
    if (state.connecting.get(key) === pending) state.connecting.delete(key);
  });
  return pending;
}

/** Connect one server, list its tools, and bridge them. Errors propagate to the caller (per-server
 *  fail-open) — but a half-open connection is torn down first so a failed connect can't orphan a child. */
async function connectServer(ctx, spec, live) {
  // Instance servers were already approved by the owner when persisted and reconnect at daemon boot with
  // no acting turn. Personal stdio rows, including legacy rows created before this gate existed, must
  // re-check the CURRENT caller before every lazy/reconnect path reaches makeTransport().
  if (spec.ownerUserId != null) assertTransportAuthority(ctx, spec);
  const key = serverKey(spec.ownerUserId, spec.name);
  setServerState(spec, { status: 'connecting', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  const { transport, child } = makeTransport(spec);
  const client = new Client({ name: 'elowen-mcp-bridge', version: '0.1.2' }, { capabilities: {} });
  // `closing` suppresses the onclose transition below during OUR OWN deliberate teardown (reload/cleanup)
  // so a normal shutdown is never reported as a crash.
  const entry = { key, name: spec.name, ownerUserId: spec.ownerUserId, client, transport, child, closing: false, lastTransportError: undefined };
  live.push(entry);
  const connectTimeoutMs = configNumber(ctx.config?.connectTimeoutMs, CONNECT_TIMEOUT_MS, 5000, 60000);
  try {
    await withTimeout(client.connect(transport), connectTimeoutMs, `mcp connect ${spec.name}`);
    // Page through the whole tool list — same pattern as the resource listing below. A server that
    // paginates would otherwise expose only its first page, and the status would report a wrong count.
    const tools = [];
    let cursor;
    do {
      const res = await withTimeout(client.listTools(cursor ? { cursor } : undefined), connectTimeoutMs, `mcp listTools ${spec.name}`);
      for (const tool of res?.tools ?? []) tools.push(tool);
      cursor = res?.nextCursor;
    } while (cursor);
    // Registration is deferred to connectAll/reconnect (see registerBridgedTools): registering here, as
    // each server answers, would make tool order follow connect latency — nondeterministic across restarts.
    const publicTools = tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description ?? '',
      schema: tool.inputSchema ?? null,
    }));
    persistTools(state.db, spec, tools);
    spec.cachedBridged = tools;
    setServerState(spec, {
      status: 'connected',
      transport: transportKind(spec),
      lastError: null,
      toolCount: tools.length,
      tools: publicTools,
      // The descriptors VERBATIM, beside the flattened `tools` above. The flattening is lossy for exactly
      // the fields registration reads (a tool with no description becomes '' there, which would bridge a
      // DIFFERENT description than this process did), so bridgeSnapshot() must not be built from it.
      bridged: tools,
    });
    ctx.logger?.info?.(`mcp: connected "${spec.name}" (${tools.length} tools)`);
    // Capture the last transport error (if any) so an unexpected close can report WHY, not just THAT.
    client.onerror = (err) => { entry.lastTransportError = err instanceof Error ? err.message : String(err); };
    // The dead-client bug: without this, a crashed stdio process or a dropped HTTP/SSE connection left
    // the state lying "connected" forever, tools kept failing against a dead client, and a manual
    // reconnect no-opped because the state still said "connected". `closing` is set by our own cleanup
    // right before it calls transport/client close, so that expected teardown never triggers this path.
    client.onclose = () => {
      if (entry.closing) return;
      const i = live.indexOf(entry);
      if (i >= 0) live.splice(i, 1);
      setServerState(spec, {
        status: 'disconnected',
        lastError: entry.lastTransportError ?? 'connection closed unexpectedly',
        toolCount: 0,
        tools: [],
        bridged: [],
      });
      ctx.logger?.warn?.(`mcp: "${spec.name}" disconnected unexpectedly`);
    };
    return tools;
  } catch (e) {
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    try { await transport.close?.(); } catch { /* ignore */ }
    killTree(child);
    setServerState(spec, { status: 'error', lastError: e instanceof Error ? e.message : String(e), toolCount: 0, tools: [], bridged: [] });
    throw e;
  }
}

/** Connect every enabled server in parallel, each bounded and fail-open. Tool registration is deferred
 *  until every server has answered (registerBridgedTools) so the resulting order is sorted by tool name
 *  rather than by response latency — tool order is part of the cached prompt prefix and must be stable
 *  across restarts. */
async function connectAll(ctx, specs, live) {
  const enabled = specs.filter((s) => s && s.enabled && s.name && s.ownerUserId == null);
  const results = await Promise.allSettled(
    enabled.map((s) => connectServer(ctx, s, live).catch((e) => ctx.logger?.warn?.(`mcp: server "${s.name}" failed: ${e?.message ?? e}`))),
  );
  const perServer = [];
  enabled.forEach((s, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) perServer.push({ spec: s, tools: r.value });
  });
  registerBridgedTools(ctx, connectedClient(live), perServer);
}

function registerManagementTools(ctx) {
  const scopeSchema = Type.Union([Type.Literal('personal'), Type.Literal('instance')], {
    description: "Required ownership scope. 'personal' belongs to the acting Elowen account; 'instance' is shared and owner-only.",
  });
  const nameSchema = Type.String({ description: 'MCP server name' });

  ctx.registerTool(defineTool({
    name: 'AddMcpServer', label: 'Add MCP server',
    description: 'Add and verify an MCP server, then expose its tools after the current turn reloads. `scope` is required: personal stores remote HTTP/SSE servers for the acting account only; instance shares them across the instance and is restricted to administrators. A stdio server RUNS the supplied command as a local process and is therefore restricted to administrators regardless of scope.',
    parameters: Type.Object({
      scope: scopeSchema,
      name: nameSchema,
      transport: Type.Union([Type.Literal('stdio'), Type.Literal('http'), Type.Literal('sse')]),
      command: Type.Optional(Type.String({ description: 'Executable for stdio transport' })),
      args: Type.Optional(Type.Array(Type.String(), { description: 'Arguments for the stdio command' })),
      env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Environment variables for the stdio process, including any credentials the server needs' })),
      url: Type.Optional(Type.String({ description: 'HTTP(S) URL for http or sse transport' })),
      enabled: Type.Optional(Type.Boolean({ description: 'Whether the server is enabled (default true)' })),
    }),
    execute: async (_id, p) => {
      try {
        const server = await addMcpServerForScope(ctx, p.scope, p);
        return ok(`Added ${p.scope} MCP server "${server.name}" with ${server.toolCount} tool(s).`, { server });
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ListMcpServers', label: 'List MCP servers',
    description: 'List MCP servers in one explicit ownership scope. Personal lists only the acting account\'s servers; instance is owner-only. Credentials and command environments are never returned.',
    parameters: Type.Object({ scope: scopeSchema }),
    execute: async (_id, p) => {
      try {
        const ownerUserId = ownerForScope(ctx, p.scope);
        const servers = state.specs.filter((spec) => spec.ownerUserId === ownerUserId).map(publicServerState);
        return ok(servers.length ? JSON.stringify(servers, null, 2) : `No ${p.scope} MCP servers configured.`, { servers });
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'RemoveMcpServer', label: 'Remove MCP server',
    description: 'Permanently remove one MCP server from the required personal or instance scope and stop its live connection. Instance scope is owner-only.',
    parameters: Type.Object({ scope: scopeSchema, name: nameSchema }),
    execute: async (_id, p) => {
      try {
        const removed = await removeMcpServerForScope(ctx, p.scope, p.name);
        return ok(`Removed ${p.scope} MCP server "${p.name}".`, removed);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ReconnectMcpServer', label: 'Reconnect MCP server',
    description: 'Reconnect and re-discover tools for one MCP server in the required personal or instance scope. Personal remote credentials remain account-private; instance scope and every stdio process are owner-only.',
    parameters: Type.Object({ scope: scopeSchema, name: nameSchema }),
    execute: async (_id, p) => {
      try {
        const server = await reconnectMcpServerForScope(ctx, p.scope, p.name);
        return ok(`Reconnected ${p.scope} MCP server "${p.name}" with ${server.toolCount} tool(s).`, { server });
      } catch (e) { return fail(e); }
    },
  }));
}

function apiError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const forbidden = /only by administrators of this instance|require a linked Elowen account/.test(message);
  return {
    status: error?.status ?? (forbidden ? 403 : 409),
    body: { error: message, ...(error?.conflict ? { conflict: true, current: error.current } : {}) },
  };
}

function registerManagementApi(ctx) {
  ctx.registerApiRoute({
    path: 'servers', method: 'GET', access: 'user',
    handler: async () => {
      const identity = ctx.currentIdentity();
      const userId = identity?.elowenUserId;
      if (userId == null) return { status: 403, body: { error: 'linked Elowen account required' } };
      const personal = state.specs.filter((spec) => spec.ownerUserId === userId).map(editableServer);
      const instance = identity.owner === true
        ? state.specs.filter((spec) => spec.ownerUserId == null).map(editableServer)
        : [];
      return { body: { personal, instance, canManageInstance: identity.owner === true } };
    },
  });
  ctx.registerApiRoute({
    path: 'servers', method: 'POST', access: 'user',
    handler: async (req) => {
      try {
        const body = await req.json();
        const server = await addMcpServerForScope(ctx, body.scope, body);
        return { status: 201, body: { server: editableServer(specForOwner(ownerForScope(ctx, body.scope), server.name)) } };
      } catch (error) { return apiError(error); }
    },
  });
  ctx.registerApiRoute({
    path: 'servers', method: 'PATCH', access: 'user',
    handler: async (req) => {
      try {
        const body = await req.json();
        return { body: { server: await updateMcpServerForScope(ctx, body.scope, decodeURIComponent(req.path), body) } };
      } catch (error) { return apiError(error); }
    },
  });
  ctx.registerApiRoute({
    path: 'servers', method: 'DELETE', access: 'user',
    handler: async (req) => {
      try {
        const body = await req.json();
        return { body: await removeMcpServerForScope(ctx, body.scope, decodeURIComponent(req.path)) };
      } catch (error) { return apiError(error); }
    },
  });
  // Separate from PATCH because it is a different operation: PATCH resolves the server in the scope it is
  // ASKED for, so a request naming the new scope looks to it like a server that does not exist.
  ctx.registerApiRoute({
    path: 'transfer', method: 'POST', access: 'user',
    handler: async (req) => {
      try {
        const body = await req.json();
        return { body: { server: await moveMcpServerScope(ctx, body.fromScope, body.name, body.toScope, body.expectedRevision) } };
      } catch (error) { return apiError(error); }
    },
  });
  ctx.registerApiRoute({
    path: 'reconnect', method: 'POST', access: 'user',
    handler: async (req) => {
      try {
        const body = await req.json();
        return { body: { server: await reconnectMcpServerForScope(ctx, body.scope, body.name) } };
      } catch (error) { return apiError(error); }
    },
  });
}

function registerResourceTools(ctx, live, snapshot, ownerUserId) {
  const allowedSpecs = () => {
    const byName = new Map();
    for (const spec of state.specs) {
      if (spec.ownerUserId == null) byName.set(spec.name, spec);
      else if (ownerUserId != null && spec.ownerUserId === ownerUserId) byName.set(spec.name, spec);
    }
    return [...byName.values()];
  };
  const specFor = (name) => allowedSpecs().find((spec) => spec.name === name);
  const ensure = async (name) => {
    const targets = name ? [specFor(name)].filter(Boolean) : allowedSpecs().filter((spec) => spec.enabled);
    await Promise.allSettled(targets
      .filter((spec) => snapshot || spec.ownerUserId != null)
      .map((spec) => connectLazily(ctx, spec, live)));
  };
  const visibleLive = () => {
    const keys = new Set(allowedSpecs().map((spec) => serverKey(spec.ownerUserId, spec.name)));
    return live.filter((entry) => keys.has(entry.key));
  };
  const opts = ownerUserId == null ? undefined : { ownerUserId };

  ctx.registerTool(defineTool({
    name: 'ListMcpResources', label: 'List MCP resources',
    description: 'List available resources from connected MCP servers (optionally one server via `server`). Each resource has a server name, URI, name and description. Use ReadMcpResource to read a specific resource by its server and URI.',
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: 'Only list resources from this MCP server (by name).' })),
    }),
    execute: async (_id, p) => {
      await ensure(p?.server);
      const targets = p?.server ? visibleLive().filter((entry) => entry.name === p.server) : visibleLive();
      if (p?.server && targets.length === 0) return fail(new Error(`MCP server "${p.server}" is not connected. Use ListMcpResources with no server to see connected servers.`));
      const results = [];
      const errors = [];
      for (const entry of targets) {
        try {
          let cursor;
          do {
            const res = await withTimeout(entry.client.listResources(cursor ? { cursor } : undefined), 10_000, `mcp listResources ${entry.name}`);
            for (const r of res?.resources ?? []) results.push({ server: entry.name, uri: r.uri, name: r.name, description: r.description ?? '', mimeType: r.mimeType ?? '' });
            cursor = res?.nextCursor;
          } while (cursor);
        } catch (e) {
          if (isMethodNotFound(e)) continue;
          errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (results.length === 0 && errors.length === 0) return ok('No MCP resources available. Either no servers are connected or they expose no resources.');
      const parts = [];
      if (results.length) parts.push(results.map((r) => `[${r.server}] ${r.name} (${r.uri})${r.description ? ` — ${r.description}` : ''}`).join('\n'));
      if (errors.length) parts.push(`Errors:\n${errors.map((e) => `- ${e}`).join('\n')}`);
      return ok(parts.join('\n\n'), { count: results.length, errors: errors.length });
    },
  }), opts);

  ctx.registerTool(defineTool({
    name: 'ReadMcpResource', label: 'Read MCP resource',
    description: 'Read a specific resource from a connected MCP server by its server name and URI. Returns the resource content as text. Use ListMcpResources first to discover available resources.',
    parameters: Type.Object({
      server: Type.String({ description: 'Name of the MCP server to read from' }),
      uri: Type.String({ description: 'URI of the resource to read' }),
    }),
    execute: async (_id, p) => {
      await ensure(p.server);
      const spec = specFor(p.server);
      const entry = spec ? visibleLive().find((candidate) => candidate.key === serverKey(spec.ownerUserId, spec.name)) : undefined;
      if (!entry) return fail(new Error(`MCP server "${p.server}" is not connected. Use ListMcpResources to see available servers.`));
      try {
        const result = await withTimeout(entry.client.readResource({ uri: p.uri }), 30_000, `mcp readResource ${p.uri}`);
        const parts = Array.isArray(result?.contents) ? result.contents : [];
        const text = parts.map((c) => {
          if (c?.text != null) return String(c.text);
          if (c?.blob != null) return `[binary content: ${c.mimeType ?? 'unknown'}, ${Buffer.from(String(c.blob), 'base64').length} bytes]`;
          return '[empty content]';
        }).join('\n\n');
        return ok(text || '(no content)', { server: p.server, uri: p.uri });
      } catch (e) { return fail(e); }
    },
  }), opts);
}

export async function register(ctx) {
  const db = initStore(ctx);
  const specs = loadStoredSpecs(db);
  const live = []; // { key, name, ownerUserId, client, transport, child }
  // Handed down by a process that has ALREADY connected instance servers (the daemon → its sub-agent
  // runners). Personal server descriptors come from the shared DB cache and always connect lazily.
  const snapshot = Array.isArray(ctx.mcpBridgeSnapshot) ? ctx.mcpBridgeSnapshot : null;
  state.ctx = ctx;
  state.db = db;
  state.specs = specs.filter((s) => s && s.name);
  state.live = live;
  state.servers.clear();
  state.connecting.clear();
  for (const spec of state.specs) {
    setServerState(spec, { status: spec.enabled ? 'disconnected' : 'disabled', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  }

  // Kill every spawned child (process group) on daemon exit — a last-resort net for non-systemd runs
  // (dev). Registered per load; removed by cleanup so reloads don't stack listeners.
  const onExit = () => { for (const c of live) killTree(c.child); };
  process.once('exit', onExit);

  // close() is async for HTTP/SSE transports (sync for stdio): capture the promises and await them all so
  // a rejected close becomes a caught, logged result — never an unhandled rejection — and a reload can't
  // overlap the previous remote transports still tearing down.
  const cleanup = async () => {
    // A lazy connect still in flight belongs to the load being torn down: forget it so the next load's
    // first call starts a fresh one instead of sharing a promise whose transport this cleanup is killing.
    state.connecting.clear();
    const closing = [];
    for (const c of live.splice(0)) {
      // Deliberate teardown, not a crash: suppress the onclose transition before triggering it.
      c.closing = true;
      try { const p = c.transport?.close?.(); if (p?.then) closing.push(p); } catch { /* ignore */ }
      killTree(c.child);
      try { const p = c.client?.close?.(); if (p?.then) closing.push(p); } catch { /* ignore */ }
    }
    await Promise.allSettled(closing);
    try { process.removeListener('exit', onExit); } catch { /* ignore */ }
  };

  // On plugin reload/disable/config-change the registry is rebuilt — tear down THIS load's servers first
  // so a config edit never orphans the previous process tree. Fires on the OLD registry before the swap.
  ctx.registerHook({ name: 'plugin.reload.before', run: async () => { await cleanup(); } });
  ctx.registerUserRemoved(async (userId) => {
    const owned = state.specs.filter((spec) => spec.ownerUserId === userId);
    for (const spec of owned) await closeLiveSpec(spec);
    state.specs = state.specs.filter((spec) => spec.ownerUserId !== userId);
    for (const spec of owned) state.servers.delete(serverKey(spec.ownerUserId, spec.name));
    state.db.prepare('DELETE FROM p_mcp_servers WHERE owner_user_id = ?').run(userId);
  });
  ctx.registerControl('mcp', {
    listServers: listMcpServers,
    bridgeSnapshot: mcpBridgeSnapshot,
    reconnectServer: reconnectMcpServer,
    reconnectDisconnected: reconnectMcpDisconnected,
    listServersFor: (ownerUserId, scope) => {
      const owner = scope === 'instance' ? null : ownerUserId;
      if (scope === 'personal' && ownerUserId == null) return [];
      return state.specs.filter((spec) => spec.ownerUserId === owner).map(publicServerState);
    },
    addServer: (scope, input) => addMcpServerForScope(ctx, scope, input),
    removeServer: (scope, name) => removeMcpServerForScope(ctx, scope, name),
    reconnectServerFor: (scope, name) => reconnectMcpServerForScope(ctx, scope, name),
  });
  registerManagementTools(ctx);
  registerManagementApi(ctx);

  if (snapshot) {
    // Same registration and same ordering as the connected path — only the client resolution differs.
    // The wire snapshot contains instance servers only; resolve each against the DB-backed spec so the
    // runner has the command/URL it needs when a tool is first called.
    const inherited = snapshot.flatMap((entry) => {
      const spec = state.specs.find((candidate) => candidate.ownerUserId == null && candidate.name === entry.serverName);
      return spec ? [{ spec, tools: entry.tools }] : [];
    });
    registerBridgedTools(ctx, lazyClient(ctx, live), inherited);
    const bridged = inherited.reduce((n, s) => n + s.tools.length, 0);
    ctx.logger?.info?.(`mcp: declared ${bridged} bridged instance tool(s) from an inherited snapshot — servers connect on first use`);
  } else {
    // Connecting blocks register() (the loader awaits it) — bounded + fail-open per instance server.
    await connectAll(ctx, specs, live);
  }

  // Personal servers never connect at daemon/runner boot. Their last successful tools/list result is
  // persisted beside the private spec, enough to compose the owner's tool schemas; first use connects the
  // matching server lazily. A server with no successful cache advertises nothing until it is reconnected.
  const personal = state.specs
    .filter((spec) => spec.ownerUserId != null && spec.enabled && spec.cachedBridged.length > 0)
    .map((spec) => ({ spec, tools: spec.cachedBridged }));
  registerBridgedTools(ctx, lazyClient(ctx, live), personal);

  // Resource tools use the same owner filtering as bridged tools. The instance pair is available
  // everywhere; each account with personal servers gets an owner-scoped pair that overrides those names
  // in its own/direct/delegated sessions and can see instance + its own servers only.
  registerResourceTools(ctx, live, snapshot, null);
  for (const ownerUserId of new Set(state.specs.flatMap((spec) => spec.ownerUserId == null ? [] : [spec.ownerUserId]))) {
    registerResourceTools(ctx, live, snapshot, ownerUserId);
  }
}

// Exported for the process-cleanup test scenario (see tests/plugins/mcpPlugin.test.ts).
export function listMcpServers(ownerUserId = null) {
  return state.specs
    .filter((spec) => spec.ownerUserId == null || (ownerUserId != null && spec.ownerUserId === ownerUserId))
    .map(publicServerState);
}

/** The bridged tool DEFINITIONS this process currently holds — everything a forked sub-agent runner needs
 *  to declare the identical tools without connecting anything (see src/plugins/mcpSnapshot.ts for the
 *  field contract, which is exactly what registerBridgedTool reads).
 *
 *  Only CONNECTED servers contribute: the snapshot has to describe the tool set this process actually
 *  registered, and a server that failed to connect contributed none. Under a snapshot itself (a runner
 *  asked) the answer is empty — a runner forks nothing, so nobody asks. */
export function mcpBridgeSnapshot() {
  const out = [];
  for (const spec of state.specs) {
    if (spec.ownerUserId != null) continue;
    const entry = state.servers.get(serverKey(spec.ownerUserId, spec.name));
    if (entry?.status !== 'connected' || !Array.isArray(entry.bridged) || entry.bridged.length === 0) continue;
    out.push({
      serverName: spec.name,
      tools: entry.bridged.map((tool) => ({
        name: tool.name,
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === 'object' ? { inputSchema: tool.inputSchema } : {}),
      })),
    });
  }
  return out;
}

export async function reconnectMcpServer(name) {
  const spec = state.specs.find((s) => s.ownerUserId == null && s.name === name);
  if (!spec) throw new Error(`unknown MCP server "${name}"`);
  if (!spec.enabled) throw new Error(`MCP server "${name}" is disabled`);
  const key = serverKey(spec.ownerUserId, spec.name);
  const current = state.servers.get(key);
  if (current?.status === 'connected') return publicServerState(spec);
  if (state.reconnecting.has(key)) return publicServerState(spec);
  if (!state.ctx) throw new Error('MCP plugin is not loaded');
  state.reconnecting.add(key);
  try {
    const tools = await connectServer(state.ctx, spec, state.live);
    // connectServer no longer registers (ordering lives in registerBridgedTools) — register here with the
    // same deterministic, name-sorted order as the initial load.
    if (tools.length) registerBridgedTools(state.ctx, connectedClient(state.live), [{ spec, tools }]);
    return publicServerState(spec);
  } finally {
    state.reconnecting.delete(key);
  }
}

export async function reconnectMcpDisconnected() {
  const targets = state.specs.filter((spec) => spec.ownerUserId == null && spec.enabled
    && ['disconnected', 'error'].includes(state.servers.get(serverKey(spec.ownerUserId, spec.name))?.status ?? 'disconnected'));
  return Promise.allSettled(targets.map((spec) => reconnectMcpServer(spec.name))).then(() => listMcpServers().filter((server) => server.scope === 'instance'));
}

export { killTree, DetachedStdioTransport, sanitize, mapResult, configNumber };
