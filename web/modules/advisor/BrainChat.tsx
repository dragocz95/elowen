'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Send, Plus, ChevronDown, Wrench, Trash2, Paperclip, X, FileText, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { useBrainSessions } from '../../lib/queries';
import { orcaClient, BASE } from '../../lib/orcaClient';
import { formatTaskTime } from '../../lib/format';
import type { BrainSearchHit, BrainUsage, StatuslineConfig } from '../../lib/types';

/** Compact token count: 999 → '999', 34 567 → '35k', 1 234 567 → '1.2M'. */
const fmtK = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** A staged attachment: images travel as base64 to the model's vision input; text files get their
 *  content inlined into the message (fenced), which works with any model. */
interface Attachment { name: string; kind: 'image' | 'text'; mimeType: string; data: string; preview?: string }

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

async function readAttachment(file: File): Promise<Attachment | null> {
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) return null;
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { name: file.name || 'obrazek.png', kind: 'image', mimeType: file.type, data: base64, preview: dataUrl };
  }
  if (file.size > MAX_TEXT_BYTES) return null;
  const text = await file.text();
  if (text.includes('\u0000')) return null; // binary — not inlinable
  return { name: file.name, kind: 'text', mimeType: file.type || 'text/plain', data: text };
}

/** An assistant turn is an ordered list of segments so text and tool calls render in the sequence they
 *  actually happened. Consecutive tool calls (no new text between them) collapse into ONE tools segment
 *  → the Claude-Code "grouped pills" look. */
type Todo = { title: string; status: string };
type ToolPill = { name: string; detail?: string; diff?: string; todos?: Todo[] };
type Segment = { kind: 'text'; text: string } | { kind: 'reasoning'; text: string } | { kind: 'tools'; tools: ToolPill[] };
type Turn = { role: 'user'; text: string } | { role: 'assistant'; segments: Segment[] };

/** Append a text delta to the running assistant turn, extending its last text segment or starting one. */
function appendText(cur: Turn[], delta: string): Turn[] {
  const last = cur[cur.length - 1];
  if (last?.role !== 'assistant') return [...cur, { role: 'assistant', segments: [{ kind: 'text', text: delta }] }];
  const segs = [...last.segments];
  const tail = segs[segs.length - 1];
  if (tail?.kind === 'text') segs[segs.length - 1] = { kind: 'text', text: tail.text + delta };
  else segs.push({ kind: 'text', text: delta });
  return [...cur.slice(0, -1), { role: 'assistant', segments: segs }];
}

/** Append a reasoning delta to the running assistant turn (its own dim segment, separate from text). */
function appendReasoning(cur: Turn[], delta: string): Turn[] {
  const last = cur[cur.length - 1];
  if (last?.role !== 'assistant') return [...cur, { role: 'assistant', segments: [{ kind: 'reasoning', text: delta }] }];
  const segs = [...last.segments];
  const tail = segs[segs.length - 1];
  if (tail?.kind === 'reasoning') segs[segs.length - 1] = { kind: 'reasoning', text: tail.text + delta };
  else segs.push({ kind: 'reasoning', text: delta });
  return [...cur.slice(0, -1), { role: 'assistant', segments: segs }];
}

/** Append a tool call, grouping it with the immediately preceding tool calls (no text in between). */
function appendTool(cur: Turn[], tool: ToolPill): Turn[] {
  const last = cur[cur.length - 1];
  if (last?.role !== 'assistant') return [...cur, { role: 'assistant', segments: [{ kind: 'tools', tools: [tool] }] }];
  const segs = [...last.segments];
  const tail = segs[segs.length - 1];
  if (tail?.kind === 'tools') segs[segs.length - 1] = { kind: 'tools', tools: [...tail.tools, tool] };
  else segs.push({ kind: 'tools', tools: [tool] });
  return [...cur.slice(0, -1), { role: 'assistant', segments: segs }];
}

/** Attach an edit's diff to the most recent tool call of the running assistant turn. */
function appendDiff(cur: Turn[], diff: string): Turn[] {
  const last = cur[cur.length - 1];
  if (last?.role !== 'assistant') return cur;
  const segs = [...last.segments];
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (seg?.kind !== 'tools') continue;
    const tools = [...seg.tools];
    tools[tools.length - 1] = { ...tools[tools.length - 1], diff };
    segs[i] = { kind: 'tools', tools };
    return [...cur.slice(0, -1), { role: 'assistant', segments: segs }];
  }
  return cur;
}

/** Attach the latest todo checklist snapshot to the most recent tool pill (mirrors `appendDiff`). */
function appendTodos(cur: Turn[], todos: Todo[]): Turn[] {
  const last = cur[cur.length - 1];
  if (last?.role !== 'assistant') return cur;
  const segs = [...last.segments];
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (seg?.kind !== 'tools') continue;
    const tools = [...seg.tools];
    tools[tools.length - 1] = { ...tools[tools.length - 1], todos };
    segs[i] = { kind: 'tools', tools };
    return [...cur.slice(0, -1), { role: 'assistant', segments: segs }];
  }
  return cur;
}

/** Sanitized-markdown block for one assistant text segment (marked + DOMPurify, no bubble). */
function TextSegment({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="chat-markdown text-sm leading-relaxed text-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

const DIFF_MAX_ROWS = 60;
/** A diff row is `-   12 text` (current pi-compatible format), `  12 - text` (legacy stored rows),
 *  or a bare unified `-text`/`+text`. */
const DIFF_SIGN = /^([+-])\s*\d+ |^\s*\d+ ([-+ ]) |^([-+])/;

/** An edit's display diff, Claude-Code style: added rows green-tinted, removed red, context muted. */
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.replace(/\n+$/, '').split('\n');
  return (
    <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-elevated p-2 font-mono text-tiny leading-relaxed">
      {lines.slice(0, DIFF_MAX_ROWS).map((l, i) => {
        const m = DIFF_SIGN.exec(l);
        const sign = m?.[1] ?? m?.[2] ?? m?.[3];
        const cls = sign === '+' ? 'bg-success/15 text-success' : sign === '-' ? 'bg-danger/15 text-danger' : 'text-text-muted';
        return <div key={i} className={cls}>{l || ' '}</div>;
      })}
      {lines.length > DIFF_MAX_ROWS ? <div className="text-text-muted">… +{lines.length - DIFF_MAX_ROWS} more lines</div> : null}
    </pre>
  );
}

/** The agent's todo checklist under the tool row: done items struck through + green, in-progress accented,
 *  pending muted — the web mirror of the CLI/Discord panel. */
function TodoBlock({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="rounded-md border border-border bg-elevated p-2 text-tiny">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-text-muted">☑ Todo <span className="tabular-nums opacity-70">{done}/{todos.length}</span></div>
      <ul className="flex flex-col gap-0.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className={`shrink-0 ${t.status === 'completed' ? 'text-success' : t.status === 'in_progress' ? 'text-accent' : 'text-text-muted'}`}>
              {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span className={t.status === 'completed' ? 'text-text-muted line-through' : 'text-text'}>{t.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A grouped row of tool-call pills (one segment = tools that ran together). The argument summary
 *  (file path, query…) rides muted next to the name; an edit's diff and a todo checklist render under the row. */
function ToolPills({ tools }: { tools: ToolPill[] }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {tools.map((tool, i) => (
          <span key={i} title={tool.detail} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated px-2 py-0.5 font-mono text-tiny text-text-muted">
            <Wrench size={9} aria-hidden className="shrink-0" />{tool.name}
            {tool.detail ? <span className="truncate opacity-60">{tool.detail}</span> : null}
          </span>
        ))}
      </span>
      {tools.filter((t) => t.diff).map((tool, i) => <DiffBlock key={i} diff={tool.diff!} />)}
      {tools.filter((t) => t.todos).map((tool, i) => <TodoBlock key={`todo-${i}`} todos={tool.todos!} />)}
    </span>
  );
}

/** One message row. User turns keep an accent bubble; assistant turns are bubble-free — plain markdown
 *  and tool-pill rows in their true order. */
function Message({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-8 self-end whitespace-pre-wrap rounded-lg rounded-br-sm border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
        {turn.text}
      </div>
    );
  }
  return (
    <div className="mr-4 flex flex-col gap-1.5 self-start">
      {turn.segments.map((seg, i) => (seg.kind === 'text'
        ? <TextSegment key={i} text={seg.text} />
        : seg.kind === 'reasoning'
        ? <p key={i} className="whitespace-pre-wrap border-l-2 border-border pl-2 text-tiny italic text-text-muted">{seg.text}</p>
        : <ToolPills key={i} tools={seg.tools} />))}
    </div>
  );
}

/** A search snippet with the first occurrence of the query highlighted. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent/30 px-0.5 text-text">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** The docked brain chat: the same server-side brain `orca chat` talks to, in the web. Streams over
 *  the daemon's SSE, keeps multiple conversations (new/resume via the session picker). */
export function BrainChat() {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const sessions = useBrainSessions();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<BrainSearchHit[] | null>(null);
  const [usage, setUsage] = useState<BrainUsage | null>(null);
  const [lineCfg, setLineCfg] = useState<StatuslineConfig | null>(null);
  /** Transient runtime line (rate-limit retry, context compaction) so a stalled turn explains itself. */
  const [notice, setNotice] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: Iterable<File>) => {
    for (const f of files) {
      const a = await readAttachment(f).catch(() => null);
      if (!a) { toast(t.brainChat.attachTooBig, 'error'); continue; }
      setAttachments((cur) => {
        if (a.kind === 'image' && cur.filter((x) => x.kind === 'image').length >= MAX_IMAGES) return cur;
        return [...cur, a];
      });
    }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const active = sessions.data?.find((s) => s.active);

  const loadHistory = async () => {
    const msgs = await orcaClient.brainMessages();
    const turns: Turn[] = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        if (m.text) turns.push({ role: 'user', text: m.text });
        continue;
      }
      // Server-built segments preserve the true text/tool order; older rows fall back to flat text.
      const source = m.segments ?? (m.text ? [{ kind: 'text' as const, text: m.text }] : []);
      const segments: Segment[] = [];
      for (const seg of source) {
        if (seg.kind === 'text') {
          segments.push({ kind: 'text', text: seg.text });
        } else {
          const tail = segments[segments.length - 1];
          const pill = { name: seg.name, detail: seg.detail, diff: seg.diff, todos: seg.todos };
          if (tail?.kind === 'tools') tail.tools.push(pill);
          else segments.push({ kind: 'tools', tools: [pill] });
        }
      }
      if (segments.length > 0) turns.push({ role: 'assistant', segments });
    }
    setTurns(turns);
  };

  // Boot: start (resume) the brain, load history, open the stream. Re-runs when the conversation flips.
  const connect = async () => {
    esRef.current?.close();
    setReady(false);
    setNotice(''); // a fresh connection (mount / session switch) starts without a stale runtime line
    await orcaClient.brainStart({});
    await loadHistory();
    const st = await orcaClient.brainStatus().catch(() => null);
    if (st) { setUsage(st.usage); setLineCfg(st.statusline); }
    const es = new EventSource(`${BASE}/brain/stream`);
    es.addEventListener('text', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setNotice(''); // first answer text clears any transient runtime notice
      setTurns((cur) => appendText(cur, delta));
    });
    // Runtime notices (retry/compaction) — mirror the CLI: show while the phase runs, clear on done.
    es.addEventListener('notice', (e) => {
      const { message, done } = JSON.parse((e as MessageEvent).data) as { message: string; done?: boolean };
      setNotice(done ? '' : message);
    });
    es.addEventListener('error', (e) => {
      // EventSource fires generic 'error' events on connection drops with no payload — those are the
      // browser's own auto-reconnect, leave them be. Only the brain's error frames carry a JSON body.
      const data = (e as MessageEvent).data;
      if (typeof data !== 'string') return;
      let message: string;
      try { message = (JSON.parse(data) as { message: string }).message; } catch { return; }
      // The server closes the stream after an error frame (e.g. "brain not started" post-restart);
      // close our side too so EventSource stops re-firing the same frame every few seconds (which
      // would spam the transcript), surface it once as a notice, and retry the full connect (which
      // re-runs brainStart and revives the session) shortly. If the brain is still down, brainStart
      // throws and the retry stops — no tight loop.
      esRef.current?.close();
      setBusy(false);
      setNotice(message);
      setTimeout(() => void connect().then(() => setNotice('')).catch(() => setReady(true)), 2000);
    });
    es.addEventListener('reasoning', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setTurns((cur) => appendReasoning(cur, delta));
    });
    es.addEventListener('tool', (e) => {
      const { name, detail } = JSON.parse((e as MessageEvent).data) as { name: string; detail?: string };
      setTurns((cur) => appendTool(cur, { name, detail }));
    });
    es.addEventListener('todo', (e) => {
      const { todos } = JSON.parse((e as MessageEvent).data) as { todos: Todo[] };
      setTurns((cur) => appendTodos(cur, todos));
    });
    es.addEventListener('diff', (e) => {
      const { diff } = JSON.parse((e as MessageEvent).data) as { diff: string };
      setTurns((cur) => appendDiff(cur, diff));
    });
    es.addEventListener('idle', (e) => {
      setBusy(false);
      setNotice(''); // turn settled → drop any transient runtime line
      try {
        const { usage: u } = JSON.parse((e as MessageEvent).data) as { usage?: BrainUsage };
        if (u) setUsage(u);
      } catch { /* idle without payload — statusline just stays put */ }
      void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    });
    esRef.current = es;
    setReady(true);
  };

  useEffect(() => {
    void connect().catch(() => setReady(true)); // surface the input even if the brain is unwired
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns]);

  // Debounced conversation search: ≥2 chars queries the daemon; anything shorter restores the list.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      orcaClient.brainSearch(q)
        .then((hits) => { if (!stale) setResults(hits); })
        .catch(() => { if (!stale) setResults([]); });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [search]);

  const submit = async () => {
    const typed = input.trim();
    if ((!typed && attachments.length === 0) || busy) return;
    // Text files inline as fenced blocks (works with any model); images ride the vision input.
    const textFiles = attachments.filter((a) => a.kind === 'text');
    const images = attachments.filter((a) => a.kind === 'image').map((a) => ({ data: a.data, mimeType: a.mimeType }));
    const text = [
      typed || t.brainChat.attachOnly,
      ...textFiles.map((a) => `\n\`${a.name}\`:\n\`\`\`\n${a.data}\n\`\`\``),
    ].join('\n');
    const shown = [typed || t.brainChat.attachOnly, ...attachments.map((a) => `📎 ${a.name}`)].join('\n');
    setInput('');
    setAttachments([]);
    setBusy(true);
    setTurns((cur) => [...cur, { role: 'user', text: shown }]);
    try { await orcaClient.brainSend(text, images); } catch { setBusy(false); }
  };

  const switchSession = async (opts: { session?: string; fresh?: boolean }) => {
    setPickerOpen(false);
    setSearch('');
    await orcaClient.brainStart(opts);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    await connect();
  };

  const deleteSession = async (id: string, wasActive: boolean) => {
    await orcaClient.brainDeleteSession(id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    // Deleting the open conversation re-targets to the most recent remaining one (or a fresh state).
    if (wasActive) { setPickerOpen(false); await connect(); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Conversation bar: current title + picker + new chat. */}
      <div className="relative flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => { setPickerOpen((v) => !v); setSearch(''); }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text transition-colors hover:bg-elevated"
        >
          <span className="truncate">{active?.title || t.brainChat.newChat}</span>
          <ChevronDown size={14} className="shrink-0 text-text-muted" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void switchSession({ fresh: true })}
          aria-label={t.brainChat.newChat}
          title={t.brainChat.newChat}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <Plus size={16} aria-hidden />
        </button>
        {pickerOpen ? (
          <div className="absolute left-2 right-2 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-lg">
            {/* Fulltext search across the caller's conversations; a live query swaps the list for hits. */}
            <div className="mb-1 flex items-center gap-1.5 rounded-md border border-border bg-bg px-2">
              <Search size={13} className="shrink-0 text-text-muted" aria-hidden />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.brainChat.searchPlaceholder}
                aria-label={t.brainChat.searchPlaceholder}
                autoFocus
                className="w-full bg-transparent py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none"
              />
            </div>
            {search.trim().length >= 2 ? (
              results === null ? null : results.length === 0 ? (
                <p className="px-2 py-2 text-xs text-text-muted">{t.brainChat.searchEmpty}</p>
              ) : (
                results.map((h, i) => {
                  const when = formatTaskTime(h.ts, Date.now(), locale);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => void switchSession({ session: h.sessionId }).catch(() => toast(t.brainChat.searchOpenError, 'error'))}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface"
                    >
                      <span className="flex w-full items-baseline justify-between gap-2">
                        <span className="truncate text-sm text-text">{h.sessionTitle || t.brainChat.untitled}</span>
                        <span className="shrink-0 text-tiny text-text-muted" title={when.title}>{when.label}</span>
                      </span>
                      <span className="w-full truncate text-tiny text-text-muted">
                        <Highlight text={h.snippet} query={search.trim()} />
                      </span>
                    </button>
                  );
                })
              )
            ) : (sessions.data ?? []).map((s) => (
              <div key={s.id} className={`group flex items-center rounded-md transition-colors hover:bg-surface ${s.active ? 'bg-surface' : ''}`}>
                <button
                  type="button"
                  onClick={() => void switchSession({ session: s.id })}
                  className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
                >
                  <span className="truncate text-sm text-text">{s.title || t.brainChat.untitled}</span>
                  <span className="truncate font-mono text-tiny text-text-muted">{s.model}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSession(s.id, s.active)}
                  aria-label={t.brainChat.deleteChat}
                  title={t.brainChat.deleteChat}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:bg-elevated hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Messages. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {turns.length === 0 && ready ? (
          <p className="m-auto max-w-[220px] text-center text-xs text-text-muted">{t.brainChat.empty}</p>
        ) : null}
        {turns.map((turn, i) => <Message key={i} turn={turn} />)}
        {notice ? <span className="ml-1 text-tiny italic text-text-muted">· {notice}</span> : null}
        {busy ? <span className="ml-1 animate-pulse text-xs text-text-muted">{t.brainChat.thinking}</span> : null}
      </div>

      {/* Statusline (the statusline plugin's toggles decide what shows; hidden when disabled). */}
      {lineCfg && (lineCfg.showModel || lineCfg.showContext || lineCfg.showTokens || lineCfg.showCost) ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border px-3 py-1 font-mono text-tiny text-text-muted">
          {lineCfg.showModel && active?.model ? <span>{active.model}</span> : null}
          {lineCfg.showContext && usage && usage.percent != null ? (
            <span>{t.brainChat.context} {Math.round(usage.percent)}% ({fmtK(usage.tokens ?? 0)}/{fmtK(usage.contextWindow)})</span>
          ) : null}
          {lineCfg.showTokens && usage ? <span>Σ {fmtK(usage.totalTokens)} tok</span> : null}
          {lineCfg.showCost && usage ? <span>${usage.cost.toFixed(2)}</span> : null}
        </div>
      ) : null}

      {/* Staged attachments. */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated py-1 pl-1.5 pr-1 text-tiny text-text">
              {a.kind === 'image' && a.preview
                ? <img src={a.preview} alt={a.name} className="h-6 w-6 rounded object-cover" />
                : <FileText size={13} className="text-text-muted" aria-hidden />}
              <span className="max-w-[140px] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                aria-label={t.brainChat.attachRemove}
                className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-text"
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Composer. */}
      <form
        className="flex items-end gap-2 border-t border-border p-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.log,.json,.yaml,.yml,.csv,.ts,.tsx,.js,.py,.php,.sql,.sh,.env.example"
          className="hidden"
          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label={t.brainChat.attach}
          title={t.brainChat.attach}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <Paperclip size={16} aria-hidden />
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          rows={Math.min(5, input.split('\n').length)}
          placeholder={t.brainChat.placeholder}
          className="max-h-40 flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent"
        />
        <button
          type="submit"
          disabled={(!input.trim() && attachments.length === 0) || busy}
          aria-label={t.brainChat.send}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent bg-accent/15 text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
        >
          <Send size={16} aria-hidden />
        </button>
      </form>
    </div>
  );
}
