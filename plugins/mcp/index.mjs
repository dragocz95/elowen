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

const state = {
  ctx: null,
  specs: [],
  live: [],
  reconnecting: new Set(),
  servers: new Map(),
};

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
  const entry = state.servers.get(spec.name) ?? {};
  return {
    name: spec.name,
    transport: transportKind(spec),
    status: entry.status ?? (spec.enabled ? 'disconnected' : 'disabled'),
    tools: entry.tools ?? [],
    toolCount: entry.toolCount ?? 0,
    lastError: entry.lastError ?? null,
    reconnecting: state.reconnecting.has(spec.name),
  };
}

function setServerState(name, patch) {
  const prev = state.servers.get(name) ?? {};
  state.servers.set(name, { ...prev, ...patch, updatedAt: new Date().toISOString() });
}

/** Map an MCP tool-call result into the brain tool-result shape. */
function mapResult(res) {
  const parts = Array.isArray(res?.content) ? res.content : [];
  const content = parts.map((p) => (p?.type === 'text' ? { type: 'text', text: String(p.text ?? '') } : { type: 'text', text: JSON.stringify(p) }));
  if (!content.length) content.push({ type: 'text', text: res?.isError ? 'MCP tool returned an error.' : '(no output)' });
  return { content, details: { ok: !res?.isError, isError: !!res?.isError } };
}

/** Register one remote MCP tool as a native brain tool (namespaced `mcp__<server>__<tool>`).
 *  Double separators on purpose: a sanitized server or tool name may itself contain `_`, so the old
 *  single-underscore form could not be split back apart unambiguously. */
function registerBridgedTool(ctx, client, serverName, tool) {
  const name = `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`;
  const params = tool.inputSchema && typeof tool.inputSchema === 'object' ? Type.Unsafe(tool.inputSchema) : Type.Object({});
  ctx.registerTool(defineTool({
    name,
    label: tool.title || tool.name,
    description: `[${serverName}] ${tool.description ?? tool.name}`.slice(0, 1024),
    parameters: params,
    execute: async (_id, args) => {
      try {
        const callTimeoutMs = configNumber(ctx.config?.callTimeoutMs, CALL_TIMEOUT_MS, 30000, 300000);
        const res = await withTimeout(client.callTool({ name: tool.name, arguments: args ?? {} }), callTimeoutMs, `mcp call ${tool.name}`);
        return mapResult(res);
      } catch (e) { return fail(e); }
    },
  }));
}

/** Connect one server, list its tools, and bridge them. Errors propagate to the caller (per-server
 *  fail-open) — but a half-open connection is torn down first so a failed connect can't orphan a child. */
async function connectServer(ctx, spec, live) {
  setServerState(spec.name, { status: 'connecting', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  const { transport, child } = makeTransport(spec);
  const client = new Client({ name: 'elowen-mcp-bridge', version: '0.1.1' }, { capabilities: {} });
  const entry = { name: spec.name, client, transport, child };
  live.push(entry);
  const connectTimeoutMs = configNumber(ctx.config?.connectTimeoutMs, CONNECT_TIMEOUT_MS, 5000, 60000);
  try {
    await withTimeout(client.connect(transport), connectTimeoutMs, `mcp connect ${spec.name}`);
    const { tools } = await withTimeout(client.listTools(), connectTimeoutMs, `mcp listTools ${spec.name}`);
    for (const tool of tools ?? []) registerBridgedTool(ctx, client, spec.name, tool);
    setServerState(spec.name, {
      status: 'connected',
      transport: transportKind(spec),
      lastError: null,
      toolCount: tools?.length ?? 0,
      tools: (tools ?? []).map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? '',
        schema: tool.inputSchema ?? null,
      })),
    });
    ctx.logger?.info?.(`mcp: connected "${spec.name}" (${tools?.length ?? 0} tools)`);
  } catch (e) {
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    try { await transport.close?.(); } catch { /* ignore */ }
    killTree(child);
    setServerState(spec.name, { status: 'error', lastError: e instanceof Error ? e.message : String(e), toolCount: 0, tools: [] });
    throw e;
  }
}

/** Connect every enabled server in parallel, each bounded and fail-open. */
async function connectAll(ctx, specs, live) {
  await Promise.allSettled(
    specs
      .filter((s) => s && s.enabled && s.name)
      .map((s) => connectServer(ctx, s, live).catch((e) => ctx.logger?.warn?.(`mcp: server "${s.name}" failed: ${e?.message ?? e}`))),
  );
}

export async function register(ctx) {
  const specs = Array.isArray(ctx.config?.servers) ? ctx.config.servers : [];
  const live = []; // { name, client, transport, child }
  state.ctx = ctx;
  state.specs = specs.filter((s) => s && s.name);
  state.live = live;
  state.servers.clear();
  for (const spec of state.specs) {
    setServerState(spec.name, { status: spec.enabled ? 'disconnected' : 'disabled', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  }

  // Kill every spawned child (process group) on daemon exit — a last-resort net for non-systemd runs
  // (dev). Registered per load; removed by cleanup so reloads don't stack listeners.
  const onExit = () => { for (const c of live) killTree(c.child); };
  process.once('exit', onExit);

  // close() is async for HTTP/SSE transports (sync for stdio): capture the promises and await them all so
  // a rejected close becomes a caught, logged result — never an unhandled rejection — and a reload can't
  // overlap the previous remote transports still tearing down.
  const cleanup = async () => {
    const closing = [];
    for (const c of live.splice(0)) {
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
  ctx.registerControl('mcp', {
    listServers: listMcpServers,
    reconnectServer: reconnectMcpServer,
    reconnectDisconnected: reconnectMcpDisconnected,
  });

  // Connecting blocks register() (the loader awaits it) — bounded + fail-open per server above.
  await connectAll(ctx, specs, live);
}

// Exported for the process-cleanup test scenario (see tests/plugins/mcpPlugin.test.ts).
export function listMcpServers() {
  return state.specs.map(publicServerState);
}

export async function reconnectMcpServer(name) {
  const spec = state.specs.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown MCP server "${name}"`);
  if (!spec.enabled) throw new Error(`MCP server "${name}" is disabled`);
  const current = state.servers.get(name);
  if (current?.status === 'connected') return publicServerState(spec);
  if (state.reconnecting.has(name)) return publicServerState(spec);
  if (!state.ctx) throw new Error('MCP plugin is not loaded');
  state.reconnecting.add(name);
  try {
    await connectServer(state.ctx, spec, state.live);
    return publicServerState(spec);
  } finally {
    state.reconnecting.delete(name);
  }
}

export async function reconnectMcpDisconnected() {
  const targets = state.specs.filter((spec) => spec.enabled && ['disconnected', 'error'].includes(state.servers.get(spec.name)?.status ?? 'disconnected'));
  return Promise.allSettled(targets.map((spec) => reconnectMcpServer(spec.name))).then(() => listMcpServers());
}

export { killTree, DetachedStdioTransport, sanitize, mapResult, configNumber };
