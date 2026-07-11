import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LspClient, spawnStdioTransport, type Diagnostic, type LspTransport } from './client.js';
import { commandExists, detectLanguage, listServers, serverForLanguage, type LanguageServerSpec } from './servers.js';

/** The outcome of checking one file. `skipped` explains a non-check so the agent gets honest, correctly
 *  actionable guidance instead of silence or a wrong "install a server" hint:
 *   - not-a-known-language: the extension isn't code Elowen type-checks.
 *   - unsupported-language: it IS code, but Elowen has no server registered for it (installing won't help).
 *   - no-server-installed: Elowen knows the server, but it isn't on PATH (installing WILL help).
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
 *  client for it is currently running, whether Elowen can install it itself (npm), and the human install
 *  command to show otherwise. */
interface LspServerStatus { language: string; label: string; command: string; installed: boolean; running: boolean; installable: boolean; installHint: string }

/** The manager's health at a glance — reused by every UI (CLI /lsp modal, panels, REST). */
export interface LspStatus { enabled: boolean; running: boolean; servers: LspServerStatus[] }

/** Injected so tests drive the manager with a fake transport instead of spawning real servers. */
export interface LspManagerDeps {
  spawn?: (spec: LanguageServerSpec, cwd: string) => LspTransport | null;
  readFile?: (path: string) => string;
  /** Optional access boundary/default project root. Production passes the current turn's allowed root;
   *  tests may pin one. The nearest project marker is selected without walking above this directory. */
  root?: string;
  /** PATH probe for status(); injectable so tests don't depend on the host's installed binaries. */
  exists?: (command: string) => boolean;
  /** Wait for the FIRST check on a freshly spawned server — generous, it covers project indexing. */
  firstCheckTimeoutMs?: number;
  /** Wait for re-checks against a warm server. */
  recheckTimeoutMs?: number;
  /** Quiescence window after a publish before the verdict is trusted (servers publish in passes). */
  settleMs?: number;
  /** Hard daemon-wide cap for server+project processes (LRU, default 8). */
  maxClients?: number;
}

const PROJECT_MARKERS = [
  '.git', 'package.json', 'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'setup.py',
  'go.mod', 'Cargo.toml', 'CMakeLists.txt', 'compile_commands.json',
] as const;

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function pathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Find the closest project-looking ancestor of `path`, bounded by `boundary` when supplied. With no
 *  marker, use the boundary (a known allowed project) or the file's own directory — never the daemon's
 *  process.cwd(), which is `/` under systemd. */
export function projectRootForFile(path: string, boundary?: string): string {
  const start = canonical(dirname(path));
  const candidate = boundary ? canonical(boundary) : undefined;
  const floor = candidate && pathWithin(start, candidate) ? candidate : undefined;
  let current = start;
  while (true) {
    // With no explicit boundary, never promote the filesystem root merely because it happens to carry
    // a marker. A file nested in some checkout must not recreate the old daemon-wide `/` workspace.
    if (!floor && current !== start && dirname(current) === current) break;
    if (PROJECT_MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    if (current === floor) break;
    const parent = dirname(current);
    if (parent === current || (floor && !pathWithin(parent, floor))) break;
    current = parent;
  }
  return floor ?? start;
}

interface ManagedClient {
  key: string;
  command: string;
  client: LspClient;
  activeChecks: number;
  retired: boolean;
}

/** Owns the live language-server clients (one per server binary + project root, lazily spawned and reused) and turns a
 *  file path into diagnostics. Enable/disable is a single flag the `/lsp` toggle flips — when off,
 *  `checkFile` is a cheap no-op and no servers are spawned. */
export class LspManager {
  /** Insertion order is the reusable-client LRU. Retired clients are detached from lookup immediately,
   *  but remain alive until their already-running checks settle. */
  private clients = new Map<string, ManagedClient>();
  private retiredClients = new Set<ManagedClient>();
  private enabled = true;
  private readonly spawnFn: (spec: LanguageServerSpec, cwd: string) => LspTransport | null;
  private readonly readFile: (path: string) => string;
  private readonly root?: string;
  private readonly exists: (command: string) => boolean;
  private readonly firstCheckTimeoutMs: number;
  private readonly recheckTimeoutMs: number;
  private readonly settleMs: number;
  private readonly maxClients: number;

  constructor(deps: LspManagerDeps = {}) {
    this.spawnFn = deps.spawn ?? spawnStdioTransport;
    this.readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.root = deps.root;
    this.exists = deps.exists ?? commandExists;
    // The first check pays for the server's project load (tsserver on a large repo easily needs >4s —
    // with the old flat 4s it "timed out clean" and reported a false ✓); re-checks are fast.
    this.firstCheckTimeoutMs = deps.firstCheckTimeoutMs ?? 15000;
    this.recheckTimeoutMs = deps.recheckTimeoutMs ?? 4000;
    // tsserver's syntax and semantic passes arrive ~50ms apart once warm; 1s absorbs slower servers.
    this.settleMs = deps.settleMs ?? 1000;
    this.maxClients = Math.max(1, Math.floor(deps.maxClients ?? 8));
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.disposeAll(); // free the servers when the user turns LSP off
  }

  /** Whether at least one language server is currently alive. */
  isRunning(): boolean {
    return this.allClients().some((entry) => !entry.client.isDisposed());
  }

  /** Enabled/running plus a per-server row (installed on PATH? client alive?) — the single status
   *  accessor every UI reads (the CLI /lsp modal, GET /brain/lsp, any panel indicator). */
  status(): LspStatus {
    const servers = listServers().map((spec) => {
      return {
        language: spec.language,
        label: spec.label,
        command: spec.command,
        installed: this.exists(spec.command),
        running: this.hasRunningClient(spec),
        installable: !!spec.npmPackages?.length,
        installHint: spec.installHint,
      };
    });
    return { enabled: this.enabled, running: this.isRunning(), servers };
  }

  /** Type-check one file and return its diagnostics (or why it was skipped). Never throws — a spawn or
   *  server failure degrades to a `skipped`/empty result so it can't break the agent's edit loop. */
  async checkFile(path: string, boundary?: string): Promise<CheckResult> {
    if (!this.enabled) return { path, diagnostics: [], skipped: 'disabled' };
    const language = detectLanguage(path);
    if (!language) return { path, diagnostics: [], skipped: 'not-a-known-language' };
    const spec = serverForLanguage(language);
    if (!spec) return { path, language, diagnostics: [], skipped: 'unsupported-language' };
    let text: string;
    try { text = this.readFile(path); }
    catch { return { path, language, diagnostics: [], skipped: 'unreadable' }; }
    const root = projectRootForFile(path, boundary ?? this.root);
    const found = this.clientFor(spec, root);
    if (!found) return { path, language, server: spec.label, diagnostics: [], skipped: 'no-server-installed' };
    found.entry.activeChecks++;
    try {
      // A fresh server gets the generous first-check window (it's loading the project); warm re-checks
      // use the short one so a broken edit surfaces fast.
      const timeoutMs = found.fresh ? this.firstCheckTimeoutMs : this.recheckTimeoutMs;
      const { diagnostics, published } = await found.entry.client.diagnose(path, text, language, timeoutMs, this.settleMs);
      // No verdict within the window: say so instead of a false "no problems" — the worst possible
      // answer for an agent probe is a wrong all-clear.
      if (!published) {
        // publishDiagnostics is often unversioned. After a timeout, a delayed verdict for text A could
        // otherwise satisfy the next check for text B on the same URI. Quarantine the whole client;
        // the next probe starts with a fresh server and cannot consume that stale publish.
        this.retire(found.entry);
        return { path, language, server: spec.label, diagnostics: [], skipped: 'no-response' };
      }
      return { path, language, server: spec.label, diagnostics };
    } catch {
      // The server crashed/timed out — drop the client so the next check re-spawns, and say so honestly
      // (NOT "no server installed", which would send the agent chasing an install it already has).
      this.retire(found.entry);
      return { path, language, server: spec.label, diagnostics: [], skipped: 'server-error' };
    } finally {
      this.release(found.entry);
    }
  }

  private keyFor(spec: LanguageServerSpec, root: string): string { return `${spec.command}\0${root}`; }

  private hasRunningClient(spec: LanguageServerSpec): boolean {
    return this.allClients().some((entry) => entry.command === spec.command && !entry.client.isDisposed());
  }

  private allClients(): ManagedClient[] {
    return [...this.clients.values(), ...this.retiredClients];
  }

  private clientFor(spec: LanguageServerSpec, root: string): { entry: ManagedClient; fresh: boolean } | null {
    const key = this.keyFor(spec, root);
    const existing = this.clients.get(key);
    if (existing && !existing.client.isDisposed()) {
      // Map insertion order is the LRU queue. A hit becomes newest.
      this.clients.delete(key);
      this.clients.set(key, existing);
      return { entry: existing, fresh: false };
    }
    if (existing) this.retire(existing); // a crashed/exited server client — evict and respawn below
    const transport = this.spawnFn(spec, root);
    if (!transport) return null;
    this.makeRoomForClient();
    const client = new LspClient(transport, root);
    const entry: ManagedClient = { key, command: spec.command, client, activeChecks: 0, retired: false };
    this.clients.set(key, entry);
    return { entry, fresh: true };
  }

  /** Evict the oldest reusable client which is not serving a diagnostics call. When every client is busy,
   *  allow a temporary cap overflow; release() trims it as soon as one client becomes idle. */
  private makeRoomForClient(): void {
    while (this.clients.size >= this.maxClients) {
      const idle = [...this.clients.values()].find((entry) => entry.activeChecks === 0);
      if (!idle) break;
      this.clients.delete(idle.key);
      idle.retired = true;
      idle.client.dispose();
    }
  }

  private trimClients(): void {
    while (this.clients.size > this.maxClients) {
      const idle = [...this.clients.values()].find((entry) => entry.activeChecks === 0);
      if (!idle) break;
      this.clients.delete(idle.key);
      idle.retired = true;
      idle.client.dispose();
    }
  }

  /** Remove a failed/no-verdict client from future lookup now, without aborting unrelated checks already
   *  using it. Identity guards ensure an old request can never retire a replacement at the same key. */
  private retire(entry: ManagedClient): void {
    if (this.clients.get(entry.key) === entry) this.clients.delete(entry.key);
    entry.retired = true;
    if (!entry.client.isDisposed()) this.retiredClients.add(entry);
    if (entry.activeChecks === 0) this.disposeRetired(entry);
  }

  private release(entry: ManagedClient): void {
    entry.activeChecks = Math.max(0, entry.activeChecks - 1);
    if (entry.activeChecks === 0 && entry.retired) this.disposeRetired(entry);
    this.trimClients();
  }

  private disposeRetired(entry: ManagedClient): void {
    this.retiredClients.delete(entry);
    entry.client.dispose();
  }

  disposeAll(): void {
    const all = this.allClients();
    this.clients.clear();
    this.retiredClients.clear();
    for (const entry of all) {
      entry.retired = true;
      entry.client.dispose();
    }
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
