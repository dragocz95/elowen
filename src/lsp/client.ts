import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeMessage, MessageDecoder, type JsonRpcMessage } from './protocol.js';
import { commandExists, type LanguageServerSpec } from './servers.js';

/** One diagnostic the agent cares about: where it is and what's wrong. Flattened from the LSP shape so
 *  the rest of Orca never touches raw protocol objects. Lines/columns are 1-based (editor convention)
 *  even though LSP is 0-based — converted once, at the parse boundary. */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line: number;
  column: number;
  source?: string;
  code?: string;
}

const SEVERITY: Record<number, Diagnostic['severity']> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/** Interpret an LSP `textDocument/publishDiagnostics` params object into { uri, diagnostics }. Pure and
 *  defensive (servers vary): unknown severities default to 'warning', missing ranges to line 1. This is
 *  the single place raw protocol becomes Orca's Diagnostic — so it carries the unit tests. */
export function parsePublishDiagnostics(params: unknown): { uri: string; diagnostics: Diagnostic[] } {
  const p = (params && typeof params === 'object') ? params as { uri?: unknown; diagnostics?: unknown } : {};
  const uri = typeof p.uri === 'string' ? p.uri : '';
  const raw = Array.isArray(p.diagnostics) ? p.diagnostics : [];
  const diagnostics: Diagnostic[] = [];
  for (const d of raw) {
    const item = (d && typeof d === 'object') ? d as Record<string, unknown> : {};
    const start = ((item.range as { start?: { line?: unknown; character?: unknown } })?.start) ?? {};
    const message = typeof item.message === 'string' ? item.message.replace(/\s+/g, ' ').trim() : '';
    if (!message) continue;
    diagnostics.push({
      severity: SEVERITY[Number(item.severity)] ?? 'warning',
      message,
      line: Number(start.line ?? 0) + 1,
      column: Number(start.character ?? 0) + 1,
      ...(typeof item.source === 'string' && item.source ? { source: item.source } : {}),
      ...(item.code != null ? { code: String(item.code) } : {}),
    });
  }
  // Errors first, then by position — the agent reads the most important line first.
  const rank = { error: 0, warning: 1, info: 2, hint: 3 };
  diagnostics.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line || a.column - b.column);
  return { uri, diagnostics };
}

/** A bidirectional framed channel to a language server. Abstracted so LspClient is testable with a fake
 *  in-memory transport (no real server binary needed). */
export interface LspTransport {
  send(framed: string): void;
  onMessage(cb: (msg: JsonRpcMessage) => void): void;
  onExit(cb: () => void): void;
  dispose(): void;
}

/** Spawn a language server as a child process and wrap its stdio in an LspTransport. Returns null when the
 *  server binary isn't on PATH — checked SYNCHRONOUSLY up front, because `spawn` reports ENOENT only via
 *  an async 'error' event, so relying on a try/catch would return a dead-pipe transport that stalls every
 *  request. The child is detached-safe: on error/exit the transport notifies so the client can fail fast. */
export function spawnStdioTransport(spec: LanguageServerSpec, cwd: string): LspTransport | null {
  if (!commandExists(spec.command)) return null;
  let child;
  try { child = spawn(spec.command, spec.args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { return null; }
  const decoder = new MessageDecoder();
  let alive = true;
  const messageCbs: ((m: JsonRpcMessage) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  const die = (): void => { if (!alive) return; alive = false; for (const cb of exitCbs) cb(); };
  child.on('error', die); // a late ENOENT (race) or spawn failure still fails the client fast
  child.on('exit', die);
  child.stdout.on('data', (chunk: Buffer) => { for (const m of decoder.push(chunk)) for (const cb of messageCbs) cb(m); });
  child.stdin.on('error', () => { /* broken pipe — die() fires via exit */ });
  return {
    send: (framed) => { if (alive) { try { child.stdin.write(framed); } catch { /* pipe closing */ } } },
    onMessage: (cb) => { messageCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    dispose: () => { alive = false; try { child.kill(); } catch { /* already gone */ } },
  };
}

/** A minimal LSP client: initialize handshake, then open/update a document and collect the diagnostics
 *  the server publishes for it. Deliberately request/notify only what diagnostics need — this is a
 *  "did I break it?" probe for the agent, not a full editor client. */
export class LspClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  // Multiple concurrent diagnose() calls can await the SAME uri — keep every waiter, not just the last,
  // or an earlier caller's promise would never settle.
  private diagnosticWaiters = new Map<string, ((d: Diagnostic[]) => void)[]>();
  // Which documents have been opened (didOpen). A re-check must send didChange, not a second didOpen
  // (which LSP forbids and servers ignore — they'd keep the stale first text). Tracks the doc version too.
  private openVersions = new Map<string, number>();
  private starting: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly transport: LspTransport, private readonly rootPath: string) {
    transport.onMessage((msg) => this.onMessage(msg));
    transport.onExit(() => this.onExit());
  }

  isDisposed(): boolean { return this.disposed; }

  private onExit(): void {
    this.disposed = true;
    // Fail every in-flight request so no caller hangs on a dead server.
    for (const { reject } of this.pending.values()) reject(new Error('language server exited'));
    this.pending.clear();
    // Release diagnostics waiters with whatever is cached (usually []), so their promises settle.
    for (const [uri, waiters] of this.diagnosticWaiters) {
      const cached = this.diagnosticsByUri.get(uri) ?? [];
      for (const w of waiters) w(cached);
    }
    this.diagnosticWaiters.clear();
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = parsePublishDiagnostics(msg.params);
      this.diagnosticsByUri.set(uri, diagnostics);
      const waiters = this.diagnosticWaiters.get(uri);
      if (waiters) { this.diagnosticWaiters.delete(uri); for (const w of waiters) w(diagnostics); }
    }
  }

  private notify(method: string, params: unknown): void {
    this.transport.send(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  private request(method: string, params: unknown, timeoutMs = 8000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP ${method} timed out`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.transport.send(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Run the initialize/initialized handshake exactly once, even under concurrent diagnose() calls (a
   *  second `initialize` is a protocol error). The in-flight promise is memoized. */
  private start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.request('initialize', {
        processId: process.pid, // let the server watchdog exit if the daemon dies
        rootUri: pathToFileURL(this.rootPath).href,
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: false } } },
        workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: 'root' }],
      });
      this.notify('initialized', {});
    })();
    return this.starting;
  }

  /** Open (or, on a re-check, update) a document and resolve with the diagnostics the server publishes for
   *  it. Waits up to `timeoutMs`; resolves with whatever is cached (often []) if the server stays silent,
   *  so a healthy file returns no diagnostics rather than hanging the agent. Throws only if the server is
   *  gone (so the manager can evict + respawn). */
  async diagnose(path: string, text: string, language: string, timeoutMs = 4000): Promise<Diagnostic[]> {
    if (this.disposed) throw new Error('language server disposed');
    await this.start();
    const uri = pathToFileURL(path).href;
    const wait = new Promise<Diagnostic[]>((resolve) => {
      const list = this.diagnosticWaiters.get(uri) ?? [];
      list.push(resolve);
      this.diagnosticWaiters.set(uri, list);
      const timer = setTimeout(() => {
        const remaining = (this.diagnosticWaiters.get(uri) ?? []).filter((w) => w !== resolve);
        if (remaining.length) this.diagnosticWaiters.set(uri, remaining); else this.diagnosticWaiters.delete(uri);
        resolve(this.diagnosticsByUri.get(uri) ?? []);
      }, timeoutMs);
      timer.unref?.();
    });
    // First sight of a doc → didOpen; thereafter → didChange with a monotone version (re-opening is a
    // protocol violation and servers keep the stale first text otherwise).
    const version = (this.openVersions.get(uri) ?? 0) + 1;
    this.openVersions.set(uri, version);
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: language, version, text } });
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    return wait;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort graceful shutdown (request then notify), then drop the transport.
    try { this.notify('shutdown', null); this.notify('exit', null); } catch { /* transport may be dead */ }
    this.transport.dispose();
  }
}
