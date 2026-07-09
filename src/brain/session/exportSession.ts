import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../../store/brainStore.js';
import { rehydrate } from '../persistence.js';

export type ExportFormat = 'html' | 'jsonl';

/** A ready-to-stream export sitting in a private temp dir. `cleanup()` removes that dir (call it once
 *  the bytes are read out). */
export interface SessionExport {
  path: string;
  filename: string;
  contentType: string;
  cleanup(): void;
}

/** PI ships its transcript→HTML renderer (the TUI `/export` command) in `core/export-html`, but its
 *  package `exports` map only publishes the main entry and `rpc-entry` — the renderer is not importable
 *  by specifier. Reaching it by ABSOLUTE file path (resolved off the published main entry) bypasses the
 *  `exports` gate without reimplementing PI's HTML template, so the output stays PI's own, versioned one.
 *  `exportFromFile` renders a saved JSONL session file to a self-contained HTML page. */
type ExportFromFile = (inputPath: string, options?: { outputPath?: string; themeName?: string }) => Promise<string>;
let exportFromFileFn: ExportFromFile | undefined;

/** Locate PI's (non-exported) export-html module by the standard node_modules walk from THIS file — the
 *  only way to reach it, since the package `exports` map blocks both the subpath specifier and
 *  `import.meta.resolve` (and the latter isn't even a function under some test runners). Works the same
 *  from the built `dist/` tree and the `src/` tree run under vitest. */
function locateExportHtml(): string {
  const rel = join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'export-html', 'index.js');
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('pi-coding-agent export-html module not found');
    dir = parent;
  }
}

async function loadExportFromFile(): Promise<ExportFromFile> {
  if (exportFromFileFn) return exportFromFileFn;
  const mod = (await import(pathToFileURL(locateExportHtml()).href)) as { exportFromFile: ExportFromFile };
  exportFromFileFn = mod.exportFromFile;
  return exportFromFileFn;
}

/** Serialize a session manager's current branch to PI's JSONL session-file format — the exact shape of
 *  `AgentSession.exportToJsonl` (header line + branch entries re-chained into a linear parent chain), so
 *  the same file round-trips back through `SessionManager.open` / `exportFromFile`. Kept in lockstep with
 *  PI because it is not callable without a live AgentSession. */
function serializeToJsonl(sm: SessionManager): string {
  const header = {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: sm.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sm.getCwd(),
  };
  const lines = [JSON.stringify(header)];
  let prevId: string | null = null;
  for (const entry of sm.getBranch()) {
    lines.push(JSON.stringify({ ...entry, parentId: prevId }));
    prevId = entry.id;
  }
  return `${lines.join('\n')}\n`;
}

/** A filesystem-safe basename derived from the session title (falls back to the id). Both branches go
 *  through the same slug filter, so nothing outside [a-z0-9-] ever reaches the filename header. */
function exportBasename(title: string, sessionId: string): string {
  const slugify = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `elowen-${slugify(title) || slugify(sessionId) || 'session'}`;
}

/** Produce a downloadable export of a stored conversation. Rehydrates the session from the store (the
 *  sole history source — no live PI session needed), writes PI's JSONL session file to a private temp
 *  dir, and — for HTML — renders that file through PI's own exporter. The returned `path` is the file to
 *  stream; `cleanup()` drops the whole temp dir afterwards. Ownership is the caller's responsibility. */
export async function exportBrainSession(o: {
  store: BrainStore;
  sessionId: string;
  cwd: string;
  title: string;
  format: ExportFormat;
}): Promise<SessionExport> {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-export-'));
  const cleanup = (): void => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  try {
    const sm = rehydrate(o.store, o.sessionId, o.cwd);
    const base = exportBasename(o.title, o.sessionId);
    const jsonlPath = join(dir, `${base}.jsonl`);
    writeFileSync(jsonlPath, serializeToJsonl(sm), 'utf8');
    if (o.format === 'jsonl') {
      return { path: jsonlPath, filename: `${base}.jsonl`, contentType: 'application/x-ndjson', cleanup };
    }
    const exportFromFile = await loadExportFromFile();
    const htmlPath = await exportFromFile(jsonlPath, { outputPath: join(dir, `${base}.html`) });
    return { path: htmlPath, filename: `${base}.html`, contentType: 'text/html; charset=utf-8', cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
