import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../../store/brainStore.js';
import { rehydrateWithTimestamps } from '../persistence.js';
import { shapeBrainMessages, type BrainMessageView } from '../messageView.js';

export type ExportFormat = 'html' | 'jsonl';

/** A ready-to-stream export sitting in a private temp dir. `cleanup()` removes that dir (call it once
 *  the bytes are read out). */
export interface SessionExport {
  path: string;
  filename: string;
  contentType: string;
  cleanup(): void;
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** Colorize a display diff line-by-line by its leading sign (+/-/space) for the HTML export. */
function renderDiff(diff: string): string {
  const rows = diff.split('\n').map((line) => {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(line)}</span>`;
  });
  return `<pre class="diff">${rows.join('\n')}</pre>`;
}

/** One assistant tool segment → an HTML block: the tool name + argument summary, an optional colorized
 *  diff, and any console/result output body. */
function renderTool(seg: { name: string; detail?: string; diff?: string; output?: { text?: string; notes?: string[] }; sub?: { status: string; detail?: string; tools: number; tokens?: number; seconds: number; model?: string } }): string {
  const head = `<div class="tool-head"><span class="tool-name">${esc(seg.name)}</span>${seg.detail ? `<span class="tool-detail">${esc(seg.detail)}</span>` : ''}</div>`;
  const diff = seg.diff ? renderDiff(seg.diff) : '';
  const outText = seg.output?.text?.trim() ? `<pre class="tool-out">${esc(seg.output.text)}</pre>` : '';
  const notes = (seg.output?.notes ?? []).map((n) => `<div class="tool-note">${esc(n)}</div>`).join('');
  const sub = seg.sub
    ? `<div class="tool-sub">sub-agent · ${esc(seg.sub.status)} · ${seg.sub.tools} tools${seg.sub.tokens == null ? '' : ` · ${seg.sub.tokens} tokens`} · ${seg.sub.seconds}s${seg.sub.model ? ` · ${esc(seg.sub.model)}` : ''}${seg.sub.detail ? `<br>${esc(seg.sub.detail)}` : ''}</div>`
    : '';
  return `<div class="tool">${head}${diff}${outText}${notes}${sub}</div>`;
}

/** Render a shaped transcript to a self-contained HTML page. This is Elowen's OWN renderer over the same
 *  `shapeBrainMessages` view the web/CLI clients use — deliberately NOT PI's `core/export-html`, which is
 *  outside the package `exports` map and would only be reachable by a fragile deep file-path import that a
 *  PI update could break at runtime. Fully inline (no external assets), light/dark aware. */
function renderSessionHtml(views: BrainMessageView[], title: string, generatedAt: string): string {
  const body = views.map((v) => {
    if (v.role === 'compaction') return '<div class="divider"><span>context compacted</span></div>';
    const label = v.role === 'user' ? 'You' : 'Elowen';
    const inner = v.segments
      ? v.segments.map((s) => (s.kind === 'text' ? `<div class="text">${esc(s.text)}</div>` : renderTool(s))).join('')
      : `<div class="text">${esc(v.text)}</div>`;
    return `<div class="msg ${esc(v.role)}"><div class="role">${label}</div>${inner}</div>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --user:#eef2ff; --add:#166534; --del:#991b1b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0f; --fg:#e5e5e7; --muted:#9ca3af; --line:#26262b; --card:#17171b; --user:#1e1b3a; --add:#4ade80; --del:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 32px 20px 96px; }
  header { border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:28px; }
  header h1 { font-size:20px; margin:0 0 4px; }
  header .meta { color:var(--muted); font-size:12px; }
  .msg { margin: 0 0 22px; }
  .msg .role { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:6px; }
  .msg.user { background:var(--user); border-radius:10px; padding:12px 14px; }
  .text { white-space:pre-wrap; word-wrap:break-word; }
  .text + .text { margin-top:10px; }
  .tool { border:1px solid var(--line); border-radius:8px; margin:10px 0; overflow:hidden; }
  .tool-head { display:flex; gap:8px; align-items:baseline; background:var(--card); padding:8px 12px; font-size:13px; }
  .tool-name { font-weight:600; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .tool-detail { color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  pre.diff, pre.tool-out { margin:0; padding:10px 12px; overflow-x:auto; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre; }
  pre.tool-out { color:var(--muted); border-top:1px solid var(--line); }
  pre.diff span { display:block; }
  pre.diff .add { color:var(--add); }
  pre.diff .del { color:var(--del); }
  .tool-note { padding:6px 12px; font-size:12px; color:var(--muted); border-top:1px solid var(--line); }
  .tool-sub { padding:7px 12px; font-size:12px; color:var(--muted); border-top:1px solid var(--line); }
  .divider { text-align:center; margin:26px 0; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; position:relative; }
  .divider span { background:var(--bg); padding:0 12px; position:relative; }
  .divider::before { content:""; position:absolute; left:0; right:0; top:50%; border-top:1px solid var(--line); }
</style></head>
<body><div class="wrap">
<header><h1>${esc(title)}</h1><div class="meta">Elowen conversation · exported ${esc(generatedAt)}</div></header>
${body}
</div></body></html>
`;
}

/** Serialize a session manager's current branch to PI's JSONL session-file format — the exact shape of
 *  `AgentSession.exportToJsonl` (header line + branch entries re-chained into a linear parent chain), so
 *  the same file round-trips back through `SessionManager.open` / `exportFromFile`. Kept in lockstep with
 *  PI because it is not callable without a live AgentSession. */
function serializeToJsonl(sm: SessionManager, timestamps: string[]): string {
  const header = {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: sm.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sm.getCwd(),
  };
  const lines = [JSON.stringify(header)];
  let prevId: string | null = null;
  // The branch entries are 1:1 (in order) with the appended store rows, so overlay each row's real
  // timestamp back onto PI's Date.now() stamp — the transcript then shows when each message was said.
  sm.getBranch().forEach((entry, i) => {
    lines.push(JSON.stringify({ ...entry, parentId: prevId, ...(timestamps[i] ? { timestamp: timestamps[i] } : {}) }));
    prevId = entry.id;
  });
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
    const { sm, timestamps } = rehydrateWithTimestamps(o.store, o.sessionId, o.cwd);
    const base = exportBasename(o.title, o.sessionId);
    const jsonlPath = join(dir, `${base}.jsonl`);
    writeFileSync(jsonlPath, serializeToJsonl(sm, timestamps), 'utf8');
    if (o.format === 'jsonl') {
      return { path: jsonlPath, filename: `${base}.jsonl`, contentType: 'application/x-ndjson', cleanup };
    }
    // HTML: render with Elowen's own template over the shared shapeBrainMessages view (the same one the
    // web/CLI use), NOT PI's non-exported core/export-html — no fragile deep import to break on a PI bump.
    const views = shapeBrainMessages(o.store.getMessages(o.sessionId), o.store.getSubagentRuns(o.sessionId));
    const htmlPath = join(dir, `${base}.html`);
    writeFileSync(htmlPath, renderSessionHtml(views, o.title || o.sessionId, new Date().toISOString().slice(0, 10)), 'utf8');
    return { path: htmlPath, filename: `${base}.html`, contentType: 'text/html; charset=utf-8', cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
