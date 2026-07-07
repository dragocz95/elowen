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
import type { AskQuestion, BrainCard, BrainSearchHit, BrainModelOption, BrainUsage, SlashCommandDef, StatuslineConfig } from '../../lib/types';
import { fromHistory, pushUser, reduce, upsertCard, type ChatTurn, type ToolItem, type TranscriptEvent } from '../../lib/transcript';
import { expandSlashMessage } from '../../lib/slash';
import { BRAIN_OPEN_EVENT, consumePendingBrainSession, type BrainOpenRequest } from '../../lib/brainDock';
import { AskQuestionCard } from './AskQuestionCard';

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

/** The transcript view-model + fold live in the shared `web/lib/transcript.ts` mirror (kept in lockstep
 *  with the daemon's `src/brain/transcript.ts`) — the SSE handlers fold events through `reduce`, history
 *  loads through `fromHistory`, and cards through `upsertCard`, exactly like the CLI TUI. The dock keeps
 *  its own `busy`/`notice` React state, so `fold` takes only the reducer's resulting turns. */
const fold = (turns: ChatTurn[], e: TranscriptEvent): ChatTurn[] => reduce({ turns, thinking: true }, e).turns;

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

function ToolOutputBlock({ output }: { output: NonNullable<ToolItem['output']> }) {
  const tone = output.tone === 'warning' || output.tone === 'danger'
    ? 'border-warning/30 bg-warning/10 text-warning'
    : output.tone === 'success'
      ? 'border-success/30 bg-success/10 text-success'
      : 'border-border bg-elevated text-text-muted';
  return (
    <pre className={`max-w-full overflow-x-auto rounded-md border p-2 font-mono text-tiny leading-relaxed ${tone}`}>
      {output.command ? <div className="mb-1 text-text">$ {output.command}</div> : null}
      {output.status ? <div className="mb-1 opacity-80">{output.status}</div> : null}
      <div>{output.text || ' '}</div>
      {output.fullText && output.fullText !== output.text ? <div className="mt-1 text-text-muted">Click to expand in terminal</div> : null}
    </pre>
  );
}

/** A display card (ctx.emitCard) — the web mirror of the CLI/Discord panel: an optional title with a
 *  done/total count, a checklist (done struck through + green, in-progress accented, pending muted), and
 *  optional freeform body. The todo checklist is the canonical card. */
function CardBlock({ card }: { card: BrainCard }) {
  const items = card.items ?? [];
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <div className="rounded-md border border-border bg-elevated p-2 text-tiny">
      {(card.title || items.length > 0) ? (
        <div className="mb-1 flex items-center gap-1.5 font-medium text-text-muted">
          ☑ {card.title ?? 'Card'}
          {items.length > 0 ? <span className="tabular-nums opacity-70">{done}/{items.length}</span> : null}
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {items.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={`shrink-0 ${t.status === 'completed' ? 'text-success' : t.status === 'in_progress' ? 'text-accent' : 'text-text-muted'}`}>
                {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className={t.status === 'completed' ? 'text-text-muted line-through' : 'text-text'}>{t.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.body ? <div className="whitespace-pre-wrap text-text-muted">{card.body}</div> : null}
    </div>
  );
}

/** A grouped row of tool-call pills (one segment = tools that ran together). The argument summary
 *  (file path, query…) rides muted next to the name; an edit's diff renders under the row. */
function ToolPills({ tools }: { tools: ToolItem[] }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {tools.map((tool, i) => (
          <span key={i} title={tool.detail} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated px-2 py-0.5 font-mono text-tiny text-text-muted">
            {tool.icon ? <span aria-hidden className="shrink-0">{tool.icon}</span> : <Wrench size={9} aria-hidden className="shrink-0" />}{tool.name}
            {tool.detail ? <span className="truncate opacity-60">{tool.detail}</span> : null}
          </span>
        ))}
      </span>
      {tools.filter((t) => t.diff).map((tool, i) => <DiffBlock key={i} diff={tool.diff!} />)}
      {tools.filter((t) => t.output).map((tool, i) => <ToolOutputBlock key={i} output={tool.output!} />)}
    </span>
  );
}

/** One message row. User turns keep an accent bubble; assistant turns are bubble-free — plain markdown
 *  and tool-pill rows in their true order. */
function Message({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'you') {
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
        : <ToolPills key={i} tools={seg.items} />))}
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
  const [turns, setTurns] = useState<ChatTurn[]>([]);
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
  /** A parked ask_user_question: the turn is paused until the user picks and we POST /brain/answer. */
  const [ask, setAsk] = useState<{ id: string; questions: AskQuestion[] } | null>(null);
  /** Live display cards (ctx.emitCard) — seeded from status, kept current from the `card` event. */
  const [cards, setCards] = useState<BrainCard[]>([]);
  /** When set, we're VIEWING a non-continuable session (a Discord channel or a task worker) read-only:
   *  its history is shown, but there's no live stream and the composer is replaced by an exit banner. */
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Slash-command menu (single source of truth: GET /brain/commands). Level 0 = the command list; a
  // `picker` command (model) opens level 1 with its options. Arrow-navigable, mirrors the CLI palette.
  const [commands, setCommands] = useState<SlashCommandDef[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [modelOpts, setModelOpts] = useState<BrainModelOption[] | null>(null);
  useEffect(() => { void orcaClient.brainCommands().then((r) => setCommands(r.commands)).catch(() => { /* brain may be unwired */ }); }, []);

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
    setTurns(fromHistory(msgs).turns);
  };

  // Boot: start (resume) the brain, load history, open the stream. Re-runs when the conversation flips.
  const connect = async () => {
    esRef.current?.close();
    setReady(false);
    setNotice(''); // a fresh connection (mount / session switch) starts without a stale runtime line
    setAsk(null); // drop any parked question from the previous conversation
    setCards([]); // and any cards from the previous conversation
    await orcaClient.brainStart({});
    await loadHistory();
    const st = await orcaClient.brainStatus().catch(() => null);
    if (st) { setUsage(st.usage); setLineCfg(st.statusline); if (st.pendingAsk) setAsk(st.pendingAsk); setCards(st.cards ?? []); }
    const es = new EventSource(`${BASE}/brain/stream`);
    es.addEventListener('text', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setNotice(''); // first answer text clears any transient runtime notice
      setTurns((cur) => fold(cur, { type: 'text', delta }));
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
      setTurns((cur) => fold(cur, { type: 'reasoning', delta }));
    });
    es.addEventListener('tool', (e) => {
      const { name, detail, icon } = JSON.parse((e as MessageEvent).data) as { name: string; detail?: string; icon?: string };
      setTurns((cur) => fold(cur, { type: 'tool', name, detail, icon }));
    });
    es.addEventListener('card', (e) => {
      const { card } = JSON.parse((e as MessageEvent).data) as { card: BrainCard };
      setCards((cur) => upsertCard(cur, card));
    });
    es.addEventListener('diff', (e) => {
      const { diff } = JSON.parse((e as MessageEvent).data) as { diff: string };
      setTurns((cur) => fold(cur, { type: 'diff', diff }));
    });
    // ask_user_question parked the turn — render the inline choice card until the user answers.
    es.addEventListener('ask', (e) => {
      const { id, questions } = JSON.parse((e as MessageEvent).data) as { id: string; questions: AskQuestion[] };
      setAsk({ id, questions });
    });
    es.addEventListener('idle', (e) => {
      setBusy(false);
      setNotice(''); // turn settled → drop any transient runtime line
      setAsk(null); // a settled turn can't still be waiting on a question
      setTurns((cur) => fold(cur, { type: 'idle' })); // finalize the streaming turn (parity with the CLI fold)
      try {
        const { usage: u } = JSON.parse((e as MessageEvent).data) as { usage?: BrainUsage };
        if (u) setUsage(u);
      } catch { /* idle without payload — statusline just stays put */ }
      void qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    });
    esRef.current = es;
    setReady(true);
  };

  // Route a "open this session" request: a continuable one (own web/CLI conversation) is resumed live;
  // a non-continuable one (shared Discord channel / task worker) opens read-only.
  const openRequest = (req: BrainOpenRequest) =>
    req.continuable ? switchSession({ session: req.sessionId }) : openReadOnly(req.sessionId);

  useEffect(() => {
    // If another view asked to open a specific session (Sessions → open in chat), open THAT one instead
    // of the default active conversation; otherwise boot the active conversation as usual.
    const pending = consumePendingBrainSession();
    const boot = pending ? openRequest(pending) : connect();
    void boot.catch(() => setReady(true)); // surface the input even if the brain is unwired
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the dock is already open, a fresh "open this session" request opens it live.
  useEffect(() => {
    const onOpen = (e: Event) => {
      consumePendingBrainSession(); // this instance handles it live → clear the pending bridge
      const req = (e as CustomEvent<BrainOpenRequest>).detail;
      if (req?.sessionId) void openRequest(req).catch(() => toast(t.brainChat.searchOpenError, 'error'));
    };
    window.addEventListener(BRAIN_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(BRAIN_OPEN_EVENT, onOpen);
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
    // No busy guard: a message sent mid-turn is STEERED into the running turn server-side (delivered at
    // its next step), so the composer stays live — same as the CLI and Discord.
    if (!typed && attachments.length === 0) return;
    // Text files inline as fenced blocks (works with any model); images ride the vision input.
    const textFiles = attachments.filter((a) => a.kind === 'text');
    const images = attachments.filter((a) => a.kind === 'image').map((a) => ({ data: a.data, mimeType: a.mimeType }));
    // A plugin prompt command (`/review auth…`) sends its EXPANDED template while the transcript shows
    // what the user typed — same contract as the CLI. Built-ins/plain text pass through unchanged.
    const expanded = expandSlashMessage(typed, commands);
    const text = [
      (expanded ?? typed) || t.brainChat.attachOnly,
      ...textFiles.map((a) => `\n\`${a.name}\`:\n\`\`\`\n${a.data}\n\`\`\``),
    ].join('\n');
    const shown = [typed || t.brainChat.attachOnly, ...attachments.map((a) => `📎 ${a.name}`)].join('\n');
    setInput('');
    setAttachments([]);
    setBusy(true);
    setTurns((cur) => pushUser({ turns: cur, thinking: false }, shown).turns);
    try { await orcaClient.brainSend(text, images); } catch { setBusy(false); }
  };

  const switchSession = async (opts: { session?: string; fresh?: boolean }) => {
    setReadOnly(null); // leaving any read-only preview
    setPickerOpen(false);
    setSearch('');
    await orcaClient.brainStart(opts);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    await connect();
  };

  // View a non-continuable session (a shared Discord channel or a task worker) read-only: load its
  // stored history, show it, and swap the composer for an exit banner. No live stream is opened — the
  // owner can't post into someone else's channel or a worker's run.
  const openReadOnly = async (sessionId: string) => {
    esRef.current?.close();
    setPickerOpen(false); setSearch(''); setAsk(null); setCards([]); setBusy(false); setNotice('');
    setReadOnly(sessionId);
    const msgs = await orcaClient.brainMessages(sessionId);
    setTurns(fromHistory(msgs).turns);
    setReady(true);
  };

  // Leave the read-only preview and return to the live active conversation.
  const exitReadOnly = () => { setReadOnly(null); void connect(); };

  const deleteSession = async (id: string, wasActive: boolean) => {
    await orcaClient.brainDeleteSession(id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    // Deleting the open conversation re-targets to the most recent remaining one (or a fresh state).
    if (wasActive) { setPickerOpen(false); await connect(); }
  };

  // --- Slash menu (mirrors the CLI palette; single source of truth = GET /brain/commands). ---
  const slashQuery = input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null ? commands.filter((c) => c.name.startsWith(slashQuery)) : [];
  const runModel = async (m: BrainModelOption) => {
    setInput(''); setModelOpts(null);
    try { await orcaClient.brainSetModel({ provider: m.provider, model: m.model }); await connect(); toast(`${t.brainChat.modelSwitched} ${m.model}`, 'ok'); }
    catch (e) { toast((e as Error).message ?? 'error', 'error'); }
  };
  const runSlash = async (cmd: SlashCommandDef) => {
    if (cmd.name === 'model') { setInput(''); try { setModelOpts(await orcaClient.brainModels()); setSlashIdx(0); } catch { toast('no models', 'error'); } return; }
    setInput('');
    try {
      if (cmd.name === 'new') { await switchSession({ fresh: true }); return; }
      if (cmd.name === 'status') {
        const s = await orcaClient.brainStatus(); const u = s.usage;
        const parts = [s.model && `model: ${s.model}`, u?.percent != null && `context ${Math.round(u.percent)}%`, u && `Σ ${fmtK(u.totalTokens)} tok`, u && `$${u.cost.toFixed(2)}`].filter(Boolean) as string[];
        toast(parts.join('  ·  ') || t.brainChat.noSession, 'ok'); return;
      }
      if (cmd.name === 'help') { toast(commands.map((c) => `/${c.name}`).join('  '), 'ok'); return; }
      // A prompt macro usually wants arguments — picking it pre-fills the composer (`/review `) so the
      // user types them and submits; the submit path expands the template (args or not).
      if (cmd.kind === 'prompt') { setInput(`/${cmd.name} `); return; }
      if (cmd.kind === 'action') { const r = await orcaClient.brainCommand(cmd.name); toast(r.message ?? `/${cmd.name}`, 'ok'); return; }
      toast(`/${cmd.name}`, 'ok');
    } catch (e) { toast((e as Error).message ?? String(e), 'error'); }
  };
  const slashItems: { key: string; label: string; desc?: string; run: () => void }[] = modelOpts
    ? modelOpts.map((m) => ({ key: `${m.provider}/${m.model}`, label: m.model, desc: m.providerLabel, run: () => void runModel(m) }))
    : slashMatches.map((c) => ({ key: c.name, label: `/${c.name}`, desc: c.description, run: () => void runSlash(c) }));
  const slashOpen = slashItems.length > 0;
  const slashSel = Math.min(slashIdx, slashItems.length - 1);

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
        {cards.map((card) => <CardBlock key={card.id} card={card} />)}
        {ask ? (
          <AskQuestionCard
            key={ask.id}
            questions={ask.questions}
            onSubmit={(answers) => { void orcaClient.brainAnswer(ask.id, answers).catch(() => undefined); setAsk(null); }}
          />
        ) : null}
        {notice ? <span className="ml-1 text-tiny italic text-text-muted">· {notice}</span> : null}
        {busy && !ask ? <span className="ml-1 animate-pulse text-xs text-text-muted">{t.brainChat.thinking}</span> : null}
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

      {/* Composer — replaced by a read-only banner when viewing a channel/task session's history. */}
      {readOnly ? (
        <div className="flex items-center justify-between gap-2 border-t border-border bg-elevated/40 p-3 text-sm text-text-muted">
          <span className="flex min-w-0 items-center gap-2"><FileText size={14} className="shrink-0" aria-hidden /><span className="truncate">{t.brainChat.readOnly}</span></span>
          <button type="button" onClick={exitReadOnly} className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-text transition-colors hover:bg-elevated">{t.brainChat.readOnlyExit}</button>
        </div>
      ) : (
      <form
        className="relative flex items-end gap-2 border-t border-border p-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        {slashOpen && (
          <div className="absolute bottom-full left-2 mb-1 w-full max-w-md overflow-hidden rounded-lg border border-border bg-elevated shadow-lg">
            <div className="max-h-60 overflow-y-auto py-1">
              {slashItems.map((it, i) => (
                <button
                  key={it.key}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); it.run(); }}
                  onMouseEnter={() => setSlashIdx(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === slashSel ? 'bg-accent/15 text-text' : 'text-text-muted'}`}
                >
                  <span className="shrink-0 font-mono">{it.label}</span>
                  {it.desc && <span className="truncate text-tiny opacity-60">{it.desc}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
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
          onChange={(e) => { setInput(e.target.value); if (modelOpts) setModelOpts(null); setSlashIdx(0); }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (Math.min(i, slashItems.length - 1) + 1) % slashItems.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (Math.min(i, slashItems.length - 1) - 1 + slashItems.length) % slashItems.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); slashItems[slashSel]?.run(); return; }
              if (e.key === 'Escape') { e.preventDefault(); setModelOpts(null); setInput(''); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
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
          disabled={!input.trim() && attachments.length === 0}
          aria-label={t.brainChat.send}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent bg-accent/15 text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
        >
          <Send size={16} aria-hidden />
        </button>
      </form>
      )}
    </div>
  );
}
