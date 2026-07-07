import { readFileSync } from 'node:fs';
import { LspClient, spawnStdioTransport, type Diagnostic, type LspTransport } from './client.js';
import { detectLanguage, serverForLanguage, type LanguageServerSpec } from './servers.js';

/** The outcome of checking one file. `skipped` explains a non-check so the agent gets honest, correctly
 *  actionable guidance instead of silence or a wrong "install a server" hint:
 *   - not-a-known-language: the extension isn't code Orca type-checks.
 *   - unsupported-language: it IS code, but Orca has no server registered for it (installing won't help).
 *   - no-server-installed: Orca knows the server, but it isn't on PATH (installing WILL help).
 *   - server-error: the server is installed but crashed/timed out on this check.
 *   - unreadable / disabled: file couldn't be read / LSP is toggled off. */
export interface CheckResult {
  path: string;
  language?: string;
  server?: string;
  diagnostics: Diagnostic[];
  skipped?: 'not-a-known-language' | 'unsupported-language' | 'no-server-installed' | 'server-error' | 'unreadable' | 'disabled';
}

/** Injected so tests drive the manager with a fake transport instead of spawning real servers. */
export interface LspManagerDeps {
  spawn?: (spec: LanguageServerSpec, cwd: string) => LspTransport | null;
  readFile?: (path: string) => string;
  root?: string;
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

  constructor(deps: LspManagerDeps = {}) {
    this.spawnFn = deps.spawn ?? spawnStdioTransport;
    this.readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.root = deps.root ?? process.cwd();
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.disposeAll(); // free the servers when the user turns LSP off
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
    const client = this.clientFor(spec);
    if (!client) return { path, language, server: spec.label, diagnostics: [], skipped: 'no-server-installed' };
    try {
      const diagnostics = await client.diagnose(path, text, language);
      return { path, language, server: spec.label, diagnostics };
    } catch {
      // The server crashed/timed out — drop the client so the next check re-spawns, and say so honestly
      // (NOT "no server installed", which would send the agent chasing an install it already has).
      this.dispose(spec);
      return { path, language, server: spec.label, diagnostics: [], skipped: 'server-error' };
    }
  }

  private clientFor(spec: LanguageServerSpec): LspClient | null {
    const key = `${spec.command}:${this.root}`;
    const existing = this.clients.get(key);
    if (existing && !existing.isDisposed()) return existing;
    if (existing) this.clients.delete(key); // a crashed/exited server client — evict and respawn below
    const transport = this.spawnFn(spec, this.root);
    if (!transport) return null;
    const client = new LspClient(transport, this.root);
    this.clients.set(key, client);
    return client;
  }

  private dispose(spec: LanguageServerSpec): void {
    const key = `${spec.command}:${this.root}`;
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
  if (r.skipped === 'unreadable') return `Could not read ${r.path}.`;
  if (r.diagnostics.length === 0) return `✓ ${r.path}: no problems (${r.server}).`;
  const lines = r.diagnostics.slice(0, 20).map((d) => `  ${d.severity} ${r.path}:${d.line}:${d.column} — ${d.message}${d.source ? ` (${d.source})` : ''}`);
  const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = r.diagnostics.filter((d) => d.severity === 'warning').length;
  const more = r.diagnostics.length > 20 ? `\n  … +${r.diagnostics.length - 20} more` : '';
  return `${r.path}: ${errors} error(s), ${warnings} warning(s) (${r.server})\n${lines.join('\n')}${more}`;
}
