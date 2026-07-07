import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeMessage, MessageDecoder, type JsonRpcMessage } from './protocol.js';
import type { LanguageServerSpec } from './servers.js';

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

/** Spawn a language server as a child process and wrap its stdio in an LspTransport. Returns null if the
 *  server binary isn't on PATH (ENOENT) — the caller treats that language as unsupported on this box. */
export function spawnStdioTransport(spec: LanguageServerSpec, cwd: string): LspTransport | null {
  let child;
  try { child = spawn(spec.command, spec.args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { return null; }
  const decoder = new MessageDecoder();
  let alive = true;
  const messageCbs: ((m: JsonRpcMessage) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  child.on('error', () => { alive = false; for (const cb of exitCbs) cb(); }); // ENOENT lands here, async
  child.on('exit', () => { alive = false; for (const cb of exitCbs) cb(); });
  child.stdout.on('data', (chunk: Buffer) => { for (const m of decoder.push(chunk)) for (const cb of messageCbs) cb(m); });
  return {
    send: (framed) => { if (alive) child.stdin.write(framed); },
    onMessage: (cb) => { messageCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    dispose: () => { alive = false; try { child.kill(); } catch { /* already gone */ } },
  };
}

/** A minimal LSP client: initialize handshake, then open a document and collect the diagnostics the
 *  server publishes for it. Deliberately request/notify only what diagnostics need — this is a
 *  "did I break it?" probe for the agent, not a full editor client. */
export class LspClient {
  private nextId = 1;
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  private diagnosticWaiters = new Map<string, (d: Diagnostic[]) => void>();
  private initialized = false;
  private disposed = false;

  constructor(private readonly transport: LspTransport, private readonly rootPath: string) {
    transport.onMessage((msg) => this.onMessage(msg));
    transport.onExit(() => { this.disposed = true; });
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = parsePublishDiagnostics(msg.params);
      this.diagnosticsByUri.set(uri, diagnostics);
      const waiter = this.diagnosticWaiters.get(uri);
      if (waiter) { this.diagnosticWaiters.delete(uri); waiter(diagnostics); }
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
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.transport.send(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Run the initialize/initialized handshake (idempotent). */
  async start(): Promise<void> {
    if (this.initialized || this.disposed) return;
    await this.request('initialize', {
      processId: null,
      rootUri: pathToFileURL(this.rootPath).href,
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
      workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: 'root' }],
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  /** Open (or re-open) a document and resolve with the diagnostics the server publishes for it. Waits up
   *  to `timeoutMs` for the publish; resolves with whatever is cached (often []) if the server stays
   *  silent, so a healthy file simply returns no diagnostics rather than hanging the agent. */
  async diagnose(path: string, text: string, language: string, timeoutMs = 4000): Promise<Diagnostic[]> {
    if (this.disposed) return [];
    await this.start();
    const uri = pathToFileURL(path).href;
    const wait = new Promise<Diagnostic[]>((resolve) => {
      this.diagnosticWaiters.set(uri, resolve);
      const timer = setTimeout(() => {
        if (this.diagnosticWaiters.delete(uri)) resolve(this.diagnosticsByUri.get(uri) ?? []);
      }, timeoutMs);
      timer.unref?.();
    });
    // A fresh version each open so servers that dedupe by version re-run.
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: language, version: this.nextId++, text } });
    return wait;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.notify('exit', {}); } catch { /* transport may be dead */ }
    this.transport.dispose();
  }
}
