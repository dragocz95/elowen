import { readFileSync } from 'node:fs';
import { LspClient, spawnStdioTransport, type Diagnostic, type LspTransport } from './client.js';
import { commandExists, detectLanguage, listServers, serverForLanguage, type LanguageServerSpec } from './servers.js';

/** The outcome of checking one file. `skipped` explains a non-check so the agent gets honest, correctly
 *  actionable guidance instead of silence or a wrong "install a server" hint:
 *   - not-a-known-language: the extension isn't code Orca type-checks.
 *   - unsupported-language: it IS code, but Orca has no server registered for it (installing won't help).
 *   - no-server-installed: Orca knows the server, but it isn't on PATH (installing WILL help).
 *   - server-error: the server is installed but crashed/timed out on this check.
 *   - no-response: the server is up but published no verdict in time (likely still indexing) —
 *     crucially NOT reported as "no problems".
 *   - unreadable / disabled: file couldn't be read / LSP is toggled off. */
export interface CheckResult {
  path: string;
  language?: string;
  server?: string;
  diagnostics: Diagnostic[];
  skipped?: 'not-a-known-language' | 'unsupported-language' | 'no-server-installed' | 'server-error' | 'no-response' | 'unreadable' | 'disabled';
}

/** One registry server as the status surfaces see it: whether its binary is on PATH, whether a live
 *  client for it is currently running, whether Orca can install it itself (npm), and the human install
 *  command to show otherwise. */
interface LspServerStatus { language: string; label: string; command: string; installed: boolean; running: boolean; installable: boolean; installHint: string }

/** The manager's health at a glance — reused by every UI (CLI /lsp modal, panels, REST). */
export interface LspStatus { enabled: boolean; running: boolean; servers: LspServerStatus[] }

/** Injected so tests drive the manager with a fake transport instead of spawning real servers. */
export interface LspManagerDeps {
  spawn?: (spec: LanguageServerSpec, cwd: string) => LspTransport | null;
  readFile?: (path: string) => string;
  root?: string;
  /** PATH probe for status(); injectable so tests don't depend on the host's installed binaries. */
  exists?: (command: string) => boolean;
  /** Wait for the FIRST check on a freshly spawned server — generous, it covers project indexing. */
  firstCheckTimeoutMs?: number;
  /** Wait for re-checks against a warm server. */
  recheckTimeoutMs?: number;
  /** Quiescence window after a publish before the verdict is trusted (servers publish in passes). */
  settleMs?: number;
}

/** Owns the live language-server clients (one per server binary, lazily spawned and reused) and turns a
 *  file path into diagnostics. Enable/disable is a single flag the `/lsp` toggle flips — when off,
 *  `checkFile` is a cheap no-op and no servers are spawned. */
export class LspManager {
  private clients = new Map<string, LspClient>();
  private enabled = true;
  private readonly spawnFn: (spec: LanguageServerSpec, cwd: string) => LspTransport | null;
  private readonly readFile: (path: string) => string;
  private readonly root: string;
  private readonly exists: (command: string) => boolean;
  private readonly firstCheckTimeoutMs: number;
  private readonly recheckTimeoutMs: number;
  private readonly settleMs: number;

  constructor(deps: LspManagerDeps = {}) {
    this.spawnFn = deps.spawn ?? spawnStdioTransport;
    this.readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.root = deps.root ?? process.cwd();
    this.exists = deps.exists ?? commandExists;
    // The first check pays for the server's project load (tsserver on a large repo easily needs >4s —
    // with the old flat 4s it "timed out clean" and reported a false ✓); re-checks are fast.
    this.firstCheckTimeoutMs = deps.firstCheckTimeoutMs ?? 15000;
    this.recheckTimeoutMs = deps.recheckTimeoutMs ?? 4000;
    // tsserver's syntax and semantic passes arrive ~50ms apart once warm; 1s absorbs slower servers.
    this.settleMs = deps.settleMs ?? 1000;
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.disposeAll(); // free the servers when the user turns LSP off
  }

  /** Whether at least one language server is currently alive. */
  isRunning(): boolean {
    return [...this.clients.values()].some((c) => !c.isDisposed());
  }

  /** Enabled/running plus a per-server row (installed on PATH? client alive?) — the single status
   *  accessor every UI reads (the CLI /lsp modal, GET /brain/lsp, any panel indicator). */
  status(): LspStatus {
    const servers = listServers().map((spec) => {
      const client = this.clients.get(this.keyFor(spec));
      return {
        language: spec.language,
        label: spec.label,
        command: spec.command,
        installed: this.exists(spec.command),
        running: !!client && !client.isDisposed(),
        installable: !!spec.npmPackages?.length,
        installHint: spec.installHint,
      };
    });
    return { enabled: this.enabled, running: this.isRunning(), servers };
  }

  /** Type-check one file and return its diagnostics (or why it was skipped). Never throws — a spawn or
   *  server failure degrades to a `skipped`/empty result so it can't break the agent's edit loop. */
  async checkFile(path: string): Promise<CheckResult> {
    if (!this.enabled) return { path, diagnostics: [], skipped: 'disabled' };
    const language = detectLanguage(path);
    if (!language) return { path, diagnostics: [], skipped: 'not-a-known-language' };
    const spec = serverForLanguage(language);
    if (!spec) return { path, language, diagnostics: [], skipped: 'unsupported-language' };
    let text: string;
    try { text = this.readFile(path); }
    catch { return { path, language, diagnostics: [], skipped: 'unreadable' }; }
    const found = this.clientFor(spec);
    if (!found) return { path, language, server: spec.label, diagnostics: [], skipped: 'no-server-installed' };
    try {
      // A fresh server gets the generous first-check window (it's loading the project); warm re-checks
      // use the short one so a broken edit surfaces fast.
      const timeoutMs = found.fresh ? this.firstCheckTimeoutMs : this.recheckTimeoutMs;
      const { diagnostics, published } = await found.client.diagnose(path, text, language, timeoutMs, this.settleMs);
      // No verdict within the window: say so instead of a false "no problems" — the worst possible
      // answer for an agent probe is a wrong all-clear.
      if (!published) return { path, language, server: spec.label, diagnostics: [], skipped: 'no-response' };
      return { path, language, server: spec.label, diagnostics };
    } catch {
      // The server crashed/timed out — drop the client so the next check re-spawns, and say so honestly
      // (NOT "no server installed", which would send the agent chasing an install it already has).
      this.dispose(spec);
      return { path, language, server: spec.label, diagnostics: [], skipped: 'server-error' };
    }
  }

  private keyFor(spec: LanguageServerSpec): string { return `${spec.command}:${this.root}`; }

  private clientFor(spec: LanguageServerSpec): { client: LspClient; fresh: boolean } | null {
    const key = this.keyFor(spec);
    const existing = this.clients.get(key);
    if (existing && !existing.isDisposed()) return { client: existing, fresh: false };
    if (existing) this.clients.delete(key); // a crashed/exited server client — evict and respawn below
    const transport = this.spawnFn(spec, this.root);
    if (!transport) return null;
    const client = new LspClient(transport, this.root);
    this.clients.set(key, client);
    return { client, fresh: true };
  }

  private dispose(spec: LanguageServerSpec): void {
    const key = this.keyFor(spec);
    this.clients.get(key)?.dispose();
    this.clients.delete(key);
  }

  disposeAll(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
}

/** Render a CheckResult as a compact, agent-readable summary line block (used by the lsp tool + hook). */
export function formatCheckResult(r: CheckResult): string {
  if (r.skipped === 'not-a-known-language') return '';
  if (r.skipped === 'unsupported-language') return `LSP doesn't cover ${r.language} (no language server registered for it).`;
  if (r.skipped === 'disabled') return 'LSP is off (/lsp to enable).';
  if (r.skipped === 'no-server-installed') return `The ${r.server ?? r.language} language server isn't installed — install it to get ${r.language} diagnostics.`;
  if (r.skipped === 'server-error') return `The ${r.server ?? r.language} language server errored or timed out — no diagnostics this time (it will be retried).`;
  if (r.skipped === 'no-response') return `The ${r.server ?? r.language} language server gave no verdict on ${r.path} in time (it may still be indexing) — NOT a clean bill, re-check shortly.`;
  if (r.skipped === 'unreadable') return `Could not read ${r.path}.`;
  if (r.diagnostics.length === 0) return `✓ ${r.path}: no problems (${r.server}).`;
  const lines = r.diagnostics.slice(0, 20).map((d) => `  ${d.severity} ${r.path}:${d.line}:${d.column} — ${d.message}${d.source ? ` (${d.source})` : ''}`);
  const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = r.diagnostics.filter((d) => d.severity === 'warning').length;
  const more = r.diagnostics.length > 20 ? `\n  … +${r.diagnostics.length - 20} more` : '';
  return `${r.path}: ${errors} error(s), ${warnings} warning(s) (${r.server})\n${lines.join('\n')}${more}`;
}
