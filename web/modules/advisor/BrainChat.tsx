'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Send, Plus, ChevronDown, Wrench, Trash2, Paperclip, X, FileText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { useBrainSessions } from '../../lib/queries';
import { orcaClient, BASE } from '../../lib/orcaClient';
import type { BrainUsage, StatuslineConfig } from '../../lib/types';

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
type ToolPill = { name: string; detail?: string; diff?: string };
type Segment = { kind: 'text'; text: string } | { kind: 'tools'; tools: ToolPill[] };
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

/** Sanitized-markdown block for one assistant text segment (marked + DOMPurify, no bubble). */
function TextSegment({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="chat-markdown text-sm leading-relaxed text-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

const DIFF_MAX_ROWS = 60;
/** A diff row is `  12 - text` (the files plugin's numbered format) or a bare unified `-text`/`+text`. */
const DIFF_SIGN = /^\s*\d+ ([-+ ]) |^([-+])/;

/** An edit's display diff, Claude-Code style: added rows green-tinted, removed red, context muted. */
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.replace(/\n+$/, '').split('\n');
  return (
    <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-elevated p-2 font-mono text-tiny leading-relaxed">
      {lines.slice(0, DIFF_MAX_ROWS).map((l, i) => {
        const m = DIFF_SIGN.exec(l);
        const sign = m?.[1] ?? m?.[2];
        const cls = sign === '+' ? 'bg-success/15 text-success' : sign === '-' ? 'bg-danger/15 text-danger' : 'text-text-muted';
        return <div key={i} className={cls}>{l || ' '}</div>;
      })}
      {lines.length > DIFF_MAX_ROWS ? <div className="text-text-muted">… +{lines.length - DIFF_MAX_ROWS} more lines</div> : null}
    </pre>
  );
}

/** A grouped row of tool-call pills (one segment = tools that ran together). The argument summary
 *  (file path, query…) rides muted next to the name; an edit's diff renders under the row. */
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
        : <ToolPills key={i} tools={seg.tools} />))}
    </div>
  );
}

/** The docked brain chat: the same server-side brain `orca chat` talks to, in the web. Streams over
 *  the daemon's SSE, keeps multiple conversations (new/resume via the session picker). */
export function BrainChat() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const sessions = useBrainSessions();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [usage, setUsage] = useState<BrainUsage | null>(null);
  const [lineCfg, setLineCfg] = useState<StatuslineConfig | null>(null);
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
          const pill = { name: seg.name, detail: seg.detail, diff: seg.diff };
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
    await orcaClient.brainStart({});
    await loadHistory();
    const st = await orcaClient.brainStatus().catch(() => null);
    if (st) { setUsage(st.usage); setLineCfg(st.statusline); }
    const es = new EventSource(`${BASE}/brain/stream`);
    es.addEventListener('text', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setTurns((cur) => appendText(cur, delta));
    });
    es.addEventListener('tool', (e) => {
      const { name, detail } = JSON.parse((e as MessageEvent).data) as { name: string; detail?: string };
      setTurns((cur) => appendTool(cur, { name, detail }));
    });
    es.addEventListener('diff', (e) => {
      const { diff } = JSON.parse((e as MessageEvent).data) as { diff: string };
      setTurns((cur) => appendDiff(cur, diff));
    });
    es.addEventListener('idle', (e) => {
      setBusy(false);
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
          onClick={() => setPickerOpen((v) => !v)}
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
            {(sessions.data ?? []).map((s) => (
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
