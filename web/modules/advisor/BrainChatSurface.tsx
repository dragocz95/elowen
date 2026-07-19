'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Send, Square, Plus, ChevronDown, Wrench, Paperclip, X, FileText, Users, ChevronRight, PanelLeft } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import type { BrainCard } from '../../lib/types';
import { collectSubagents, type ChatTurn, type ToolItem } from '../../lib/transcript';
import { AskQuestionCard } from './AskQuestionCard';
import { ProcessPanel } from './ProcessPanel';
import { AgentsTable } from './AgentsTable';
import { ChatHistoryRail } from './ChatHistoryRail';
import { ModelPicker } from './ModelPicker';
import { useBrainChat } from './BrainChatProvider';

/** Compact token count: 999 → '999', 34 567 → '35k', 1 234 567 → '1.2M'. */
const fmtK = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** Sanitized-markdown block for one assistant text segment (marked + DOMPurify, no bubble). */
function TextSegment({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`chat-markdown text-sm leading-relaxed text-text ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

const DIFF_MAX_ROWS = 60;
/** How many trailing lines of a running command's live output tail to show (mirror of the CLI). */
const PROGRESS_TAIL_ROWS = 8;
/** A diff row is `-   12 text` (current pi-compatible format), `  12 - text` (legacy stored rows),
 *  or a bare unified `-text`/`+text`. */
const DIFF_SIGN = /^([+-])\s*\d+ |^\s*\d+ ([-+ ]) |^([-+])/;

/** An edit's display diff, Claude-Code style: a coloured left gutter per row (added green, removed red,
 *  context muted), no frame and no horizontal scroll — long lines wrap under the gutter so nothing is
 *  clipped or hidden behind a scrollbar. */
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.replace(/\n+$/, '').split('\n');
  return (
    <div className="my-1 overflow-hidden rounded-md bg-elevated/40 py-1">
      {lines.slice(0, DIFF_MAX_ROWS).map((l, i) => {
        const m = DIFF_SIGN.exec(l);
        const sign = m?.[1] ?? m?.[2] ?? m?.[3];
        const cls = sign === '+' ? 'border-success/50 bg-success/10 text-success'
          : sign === '-' ? 'border-danger/50 bg-danger/10 text-danger'
          : 'border-transparent text-text-muted';
        return <div key={i} className={`whitespace-pre-wrap break-words border-l-2 px-2 ${cls}`}>{l || ' '}</div>;
      })}
      {lines.length > DIFF_MAX_ROWS ? <div className="border-l-2 border-transparent px-2 text-text-muted">… +{lines.length - DIFF_MAX_ROWS} more lines</div> : null}
    </div>
  );
}

function ToolOutputBlock({ output }: { output: NonNullable<ToolItem['output']> }) {
  const tone = output.tone === 'warning' || output.tone === 'danger'
    ? 'bg-warning/10 text-warning'
    : output.tone === 'success'
      ? 'bg-success/10 text-success'
      : 'bg-elevated/40 text-text-muted';
  return (
    <div className={`my-1 overflow-hidden whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 ${tone}`}>
      {output.command ? <div className="text-text">$ {output.command}</div> : null}
      {output.status ? <div className="opacity-80">{output.status}</div> : null}
      <div>{output.text || ' '}</div>
      {output.fullText && output.fullText !== output.text ? <div className="mt-1 opacity-70">Click to expand in terminal</div> : null}
    </div>
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
          {items.map((titem, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={`shrink-0 ${titem.status === 'completed' ? 'text-success' : titem.status === 'in_progress' ? 'text-accent' : 'text-text-muted'}`}>
                {titem.status === 'completed' ? '✔' : titem.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className={titem.status === 'completed' ? 'text-text-muted line-through' : 'text-text'}>{titem.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.body ? <div className="whitespace-pre-wrap text-text-muted">{card.body}</div> : null}
    </div>
  );
}

/** The assistant's tool calls, rendered as tight monospace log rows stacked directly under each other —
 *  no pills, no chrome. A tool that produced a diff, a command output or a live progress tail is a
 *  collapsed-by-default row (chevron, expands on click); a tool with nothing to show is a plain row.
 *  Plain rows and collapsed summaries share the exact same padding, so a mixed run reads as one even
 *  column. The argument summary (file path, query…) rides muted next to the name; rows are indented
 *  (pl-4) so they sit visually deeper than the assistant's prose. The diff/output/progress blocks
 *  inherit this wrapper's mono type, so the full page's slightly larger log size flows into them. */
function ToolPills({ tools, full }: { tools: ToolItem[]; full?: boolean }) {
  return (
    <div className={`flex flex-col pl-4 font-mono leading-relaxed ${full ? 'text-[0.6875rem]' : 'text-tiny'}`}>
      {tools.map((tool, i) => {
        const rich = !!(tool.diff || tool.output || tool.progress);
        const head = (
          <>
            {tool.icon ? <span aria-hidden className="shrink-0 opacity-70">{tool.icon}</span> : <Wrench size={9} aria-hidden className="shrink-0 opacity-70" />}
            <span className="shrink-0 text-text-muted">{tool.name}</span>
            {tool.detail ? <span className="truncate opacity-60">{tool.detail}</span> : null}
          </>
        );
        if (!rich) {
          return <div key={i} className="flex items-center gap-1.5 py-0.5 text-text-muted">{head}</div>;
        }
        return (
          <details key={i} className="chat-tool">
            <summary className="flex cursor-pointer items-center gap-1.5 rounded py-0.5 text-text-muted transition-colors hover:text-text">
              {head}
              <ChevronRight size={11} aria-hidden className={`chat-tool__chev shrink-0 opacity-40 ${full ? '' : 'ml-auto'}`} />
            </summary>
            <div className="pb-0.5">
              {tool.diff ? <DiffBlock diff={tool.diff} /> : null}
              {tool.output ? <ToolOutputBlock output={tool.output} /> : null}
              {tool.progress ? <ProgressBlock text={tool.progress} /> : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** Live rolling tail of a running Bash (the `tool_progress` event): the last lines of its output
 *  as it streams, in a muted terminal block. Cleared once the final `output`/`diff` lands, so it never
 *  doubles the final dump. */
function ProgressBlock({ text }: { text: string }) {
  return (
    <div className="my-1 overflow-hidden rounded-md bg-elevated/40 px-2.5 py-1.5 text-text-muted">
      {text.split('\n').slice(-PROGRESS_TAIL_ROWS).map((l, i) => <div key={i} className="whitespace-pre-wrap break-words">{l || ' '}</div>)}
    </div>
  );
}

/** A context-compaction boundary: a subtle labelled divider standing in for the summarized-away history. */
function ContextDivider({ full }: { full?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-2 text-tiny text-text-muted ${full ? 'my-5' : 'my-1'}`} role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="shrink-0 uppercase tracking-wide">{t.brainChat.contextCompacted}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** One message row. In the full /chat page every turn is LEFT-aligned with a role dot + label (the
 *  "Popisky" design); the label only appears when the speaker CHANGES, so a run of assistant turns
 *  (one per tool round) reads as a single Elowen block instead of repeating the heading. Turns inside a
 *  run stack FLUSH (the container has no gap in the full page) and every segment carries its own
 *  symmetric margin — so the rhythm between two tool rows, or a tool row and prose, is identical whether
 *  they sit in one turn or across a turn boundary; only a speaker change opens a real block break. The
 *  compact dock keeps the tight look: a small accent bubble for the user, bubble-free markdown for the
 *  assistant. */
function Message({ turn, full, showRole }: { turn: ChatTurn; full?: boolean; showRole?: boolean }) {
  const { t } = useTranslation();
  if (turn.role === 'divider') return <ContextDivider full={full} />;

  const you = turn.role === 'you';
  const body = turn.role === 'you'
    ? <div className={`whitespace-pre-wrap text-sm leading-relaxed text-text ${full ? 'my-1.5' : ''}`}>{turn.text}</div>
    : <>{turn.segments.map((seg, i) => (seg.kind === 'text'
        ? <TextSegment key={i} text={seg.text} className={full ? 'my-1.5' : ''} />
        : seg.kind === 'reasoning'
        ? <p key={i} className={`whitespace-pre-wrap border-l-2 border-border pl-2 italic text-text-muted ${full ? 'my-1.5 text-xs' : 'text-tiny'}`}>{seg.text}</p>
        : <ToolPills key={i} tools={seg.items} full={full} />))}</>;

  if (full) {
    return (
      <div className={`grid grid-cols-[16px_1fr] gap-x-3 ${showRole ? 'mt-6 first:mt-0' : ''}`}>
        {showRole ? (
          <span aria-hidden className={`mt-1.5 h-2 w-2 rounded-full ${you ? 'bg-accent ring-4 ring-accent/15' : 'bg-text-muted'}`} />
        ) : <span aria-hidden />}
        <div className="min-w-0">
          {showRole ? <div className={`mb-0.5 text-xs font-semibold ${you ? 'text-accent' : 'text-text-muted'}`}>{you ? t.chat.roleYou : t.chat.roleElowen}</div> : null}
          <div className="flex min-w-0 flex-col">{body}</div>
        </div>
      </div>
    );
  }

  if (you) {
    return (
      <div className="ml-8 self-end whitespace-pre-wrap rounded-lg rounded-br-sm border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
        {turn.role === 'you' ? turn.text : null}
      </div>
    );
  }
  return <div className="mr-4 flex flex-col gap-1.5 self-start">{body}</div>;
}

/** The presentational brain chat surface, driven entirely by the shared controller (BrainChatProvider)
 *  read from context. It owns NO network or session state: only pure view affordances (the picker-open
 *  toggle, the slash keyboard cursor, DOM refs + autoscroll) live here, so unmounting it (Chat↔Terminál
 *  toggle, route change) never tears down the stream, draft or transcript. The conversation list / search
 *  / rename / export / delete are the shared ChatHistoryRail. `variant` selects the dock (compact) look or
 *  the wide /chat (full) look; `onOpenHistory` opens the mobile history drawer in the full variant. */
export function BrainChatSurface({ variant = 'compact', onOpenHistory }: { variant?: 'compact' | 'full'; onOpenHistory?: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const c = useBrainChat();
  const {
    turns, busy, ready, notice, ask, cards, agentsOpen, setAgentsOpen, queued, readOnly, activeSessionId,
    usage, lineCfg, input, setInput, attachments, addFiles, removeAttachment, submit, switchSession,
    openReadOnly, exitReadOnly, onQueueRemove, onAnswer, slash, sessions, focusNonce,
    ensureAttached, abort,
  } = c;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = sessions.data?.find((s) => s.active);
  // Delegated sub-agents across the transcript — the source for the workflow table + its "N agents" link.
  const subagents = useMemo(() => collectSubagents(turns), [turns]);

  const slashItems = slash.items;
  const slashOpen = slash.open;
  const slashSel = Math.min(slashIdx, slashItems.length - 1);

  // First mount of ANY chat surface (dock opened in chat mode) lazily boots the controller. Idempotent —
  // a second mount (or the BRAIN_* window events) never re-runs brainStart, so a one-shot mount call is
  // enough (and avoids re-firing on the controller's per-render identity churn).
  useEffect(() => { ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Autoscroll to the newest turn. The compact dock scrolls its own box; the full page has no inner
  // scroll box — the whole page (the shell's <main>) scrolls, so drive that instead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (variant === 'full') {
      const scroller = el.closest('main');
      scroller?.scrollTo({ top: scroller.scrollHeight });
    } else {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [turns]);

  // The controller asks the composer to focus (a compose-bridge request / a seeded draft) by bumping the
  // focus nonce — the surface owns the DOM ref, so it does the actual focus. Guard against a plain (re)mount
  // (Chat↔Terminál toggle, dock reopen) stealing focus: only an ACTUAL bump after mount focuses, never the
  // nonce value the surface happened to mount with.
  const lastFocusRef = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === lastFocusRef.current) return;
    lastFocusRef.current = focusNonce;
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [focusNonce]);

  // Opening the /model picker resets the keyboard cursor to the top (parity with the pre-lift runSlash,
  // whose setSlashIdx(0) moved into the surface since slashIdx is now surface-local view state).
  useEffect(() => { if (slash.modelOptsOpen) setSlashIdx(0); }, [slash.modelOptsOpen]);

  const newChat = () => { setPickerOpen(false); void switchSession({ fresh: true }).catch(() => toast(t.brainChat.searchOpenError, 'error')); };

  return (
    <div className={`flex flex-col ${variant === 'full' ? 'flex-1' : 'h-full min-h-0'}`} data-variant={variant}>
      {/* Conversation bar. Compact (dock): title + picker dropdown + new chat. Full (/chat): a light
          header — the shared history rail owns the session list, so here it is only the title, a mobile
          drawer toggle and new chat. Space is reserved for the model picker (Fáze 3), terminal
          (Fáze 4/5) and fullscreen (Fáze 6). */}
      {variant === 'compact' ? (
        <div className="relative flex items-center gap-1 border-b border-border px-2 py-1.5">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text transition-colors hover:bg-elevated"
          >
            <span className="truncate">{active?.title || t.brainChat.newChat}</span>
            <ChevronDown size={14} className="shrink-0 text-text-muted" aria-hidden />
          </button>
          <ModelPicker variant="compact" />
          <button
            type="button"
            onClick={newChat}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <Plus size={16} aria-hidden />
          </button>
          <ChatHistoryRail variant="dropdown" open={pickerOpen} onClose={() => setPickerOpen(false)} />
        </div>
      ) : (
        <div className="chat-gutter sticky top-0 z-10 flex items-center gap-1.5 bg-bg py-2">
          {/* No hairline under the sticky bar — a soft fade separates it from the scrolling transcript. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-4 bg-gradient-to-b from-bg to-transparent" />
          {onOpenHistory ? (
            <button
              type="button"
              onClick={onOpenHistory}
              aria-label={t.chat.openHistory}
              title={t.chat.openHistory}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
            >
              <PanelLeft size={18} aria-hidden />
            </button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{active?.title || t.brainChat.newChat}</span>
          <ModelPicker variant="full" />
          <button
            type="button"
            onClick={newChat}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <Plus size={18} aria-hidden />
          </button>
        </div>
      )}

      {/* Messages. The full /chat variant flows full-width and lets the page scroll (no inner scroll box);
          turns stack with NO container gap — each segment carries its own margin, so tool rows keep one
          uniform rhythm across turn boundaries and only a speaker change opens a block break. The compact
          dock keeps its own internal scroll and per-turn gap. */}
      <div ref={scrollRef} className={`flex flex-1 flex-col ${variant === 'full' ? 'chat-gutter py-4' : 'gap-3 min-h-0 overflow-y-auto p-3'}`}>
        {turns.length === 0 && ready ? (
          variant === 'full' ? (
            <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
              <p className="text-lg font-medium text-text">{t.chat.emptyTitle}</p>
              <p className="text-sm text-text-muted">{t.brainChat.empty}</p>
            </div>
          ) : (
            <p className="m-auto max-w-[220px] text-center text-xs text-text-muted">{t.brainChat.empty}</p>
          )
        ) : null}
        {turns.map((turn, i) => <Message key={i} turn={turn} full={variant === 'full'} showRole={i === 0 || turns[i - 1].role !== turn.role} />)}
        {/* Out-of-band extras (cards, processes, agents, questions). In the full page they get their own
            spacing group under the flush transcript; in the dock `contents` keeps them in the parent's
            gap flow exactly as before. `empty:hidden` drops the group when everything in it is null. */}
        <div className={variant === 'full' ? 'mt-4 flex flex-col gap-3 empty:hidden' : 'contents'}>
        {cards.filter((cd) => cd.id !== 'bg-processes').map((card) => <CardBlock key={card.id} card={card} />)}
        <ProcessPanel activeSessionId={activeSessionId} />
        {/* Workflow view: a clickable link that opens the table of delegated agents (drill-in / back). */}
        {subagents.length > 0 ? (
          <button
            type="button"
            onClick={() => setAgentsOpen(true)}
            className="flex items-center gap-1.5 self-start rounded-md border border-border bg-elevated px-2 py-1 text-tiny text-text-muted transition-colors hover:text-text"
          >
            <Users size={11} aria-hidden />
            <span>{subagents.filter((s) => s.status === 'running').length || subagents.length} {t.agents.link}</span>
            <ChevronRight size={12} aria-hidden />
          </button>
        ) : null}
        {agentsOpen ? (
          <AgentsTable
            agents={subagents}
            onClose={() => setAgentsOpen(false)}
            onOpen={(sessionId) => { setAgentsOpen(false); void openReadOnly(sessionId).catch(() => toast(t.brainChat.searchOpenError, 'error')); }}
          />
        ) : null}
        {ask ? (
          <AskQuestionCard
            key={ask.id}
            questions={ask.questions}
            kind={ask.kind}
            onSubmit={(answers) => onAnswer(ask.id, answers)}
          />
        ) : null}
        </div>
      </div>

      {/* Composer footer (statusline + staged attachments + queue + composer). In the full page it sticks
          to the viewport bottom so it stays reachable while the whole page scrolls behind it; the compact
          dock keeps it in normal flow at the bottom of its own scroll box. */}
      <div className={variant === 'full' ? 'sticky bottom-0 z-10 bg-bg' : ''}>
      {/* No hairline above the footer — a soft fade lets the transcript slide under it instead. */}
      {variant === 'full' ? (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-full h-6 bg-gradient-to-t from-bg to-transparent" />
      ) : null}
      {/* One-line server status notice when the daemon sends one. The running state itself is signalled by
          the composer's Stop button (no separate "thinking" spinner). Hidden while a question is pending. */}
      {notice && !ask ? (
        <div className={`flex items-center gap-2 py-1.5 font-mono text-text-muted ${variant === 'full' ? 'chat-gutter text-[0.6875rem]' : 'px-3 text-tiny'}`}>
          <span className="italic opacity-80">{notice}</span>
        </div>
      ) : null}
      {/* Statusline (the statusline plugin's toggles decide what shows; hidden when disabled). */}
      {lineCfg && (lineCfg.showModel || lineCfg.showContext || lineCfg.showTokens || lineCfg.showCost) ? (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1 font-mono text-text-muted ${variant === 'full' ? 'chat-gutter text-[0.6875rem]' : 'px-3 text-tiny'}`}>
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
        <div className={`flex flex-wrap gap-2 py-2 ${variant === 'full' ? 'chat-gutter' : 'px-3'}`}>
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated py-1 pl-1.5 pr-1 text-tiny text-text">
              {a.kind === 'image' && a.preview
                ? <img src={a.preview} alt={a.name} className="h-6 w-6 rounded object-cover" />
                : <FileText size={13} className="text-text-muted" aria-hidden />}
              <span className="max-w-[140px] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                aria-label={t.brainChat.attachRemove}
                className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-text"
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Pending mid-turn queue: messages sent while a turn streams, parked until it ends. Removable
          until delivered; hidden in the read-only session preview (no composer there). */}
      {!readOnly && queued.length > 0 ? (
        <div className={`flex flex-col gap-1 py-2 ${variant === 'full' ? 'chat-gutter' : 'px-3'}`}>
          {queued.map((q) => (
            <div key={q.id} className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-2 py-1 text-tiny">
              <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 font-medium uppercase tracking-wide text-accent">{t.brainChat.queued}</span>
              <span className="min-w-0 flex-1 truncate text-text-muted">{q.text}</span>
              <button
                type="button"
                onClick={() => onQueueRemove(q.id)}
                aria-label={t.brainChat.removeFromQueue}
                title={t.brainChat.removeFromQueue}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-muted hover:text-text"
              >
                <X size={11} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Composer — replaced by a read-only banner when viewing a channel/task session's history. */}
      {readOnly ? (
        <div className={variant === 'full' ? 'chat-gutter pb-4 pt-1' : ''}>
          <div className={`flex items-center justify-between gap-2 bg-elevated/40 p-3 text-sm text-text-muted ${variant === 'full' ? 'rounded-xl border border-border' : ''}`}>
            <span className="flex min-w-0 items-center gap-2"><FileText size={14} className="shrink-0" aria-hidden /><span className="truncate">{t.brainChat.readOnly}</span></span>
            <button type="button" onClick={exitReadOnly} className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-text transition-colors hover:bg-elevated">{t.brainChat.readOnlyExit}</button>
          </div>
        </div>
      ) : (
      <div className={variant === 'full' ? 'chat-gutter pb-4 pt-1' : ''}>
      {/* In the full page the whole composer is ONE quiet rounded field (attach + textarea + send inside
          it, Claude-style); the dock keeps its original three-control row. */}
      <form
        className={variant === 'full'
          ? 'chat-composer relative flex items-end gap-1 rounded-2xl border border-border bg-surface p-1.5 transition-colors focus-within:border-border-strong'
          : 'relative flex items-end gap-2 p-2'}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        {slashOpen && (
          <div className={`absolute bottom-full w-full max-w-md overflow-hidden rounded-lg border border-border bg-elevated shadow-lg ${variant === 'full' ? 'left-0 mb-2' : 'left-2 mb-1'}`}>
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
          className={`flex h-9 w-9 shrink-0 items-center justify-center text-text-muted transition-colors hover:bg-elevated hover:text-text ${
            variant === 'full' ? 'rounded-xl' : 'rounded-lg border border-border'
          }`}
        >
          <Paperclip size={16} aria-hidden />
        </button>
        <textarea
          ref={composerRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); if (slash.modelOptsOpen) slash.clearModelOpts(); setSlashIdx(0); }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (Math.min(i, slashItems.length - 1) + 1) % slashItems.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (Math.min(i, slashItems.length - 1) - 1 + slashItems.length) % slashItems.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); slashItems[slashSel]?.run(); return; }
              if (e.key === 'Escape') { e.preventDefault(); slash.clearModelOpts(); setInput(''); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          rows={Math.min(5, input.split('\n').length)}
          placeholder={t.brainChat.placeholder}
          className={`max-h-40 flex-1 resize-none text-sm text-text placeholder:text-text-muted ${
            variant === 'full'
              ? 'bg-transparent px-2 py-2 focus:outline-none'
              : 'rounded-lg border border-border bg-bg px-3 py-2 focus:border-accent'
          }`}
        />
        {busy ? (
          <button
            type="button"
            onClick={abort}
            aria-label={t.brainChat.stop}
            className={`flex h-9 w-9 shrink-0 items-center justify-center transition-colors ${
              variant === 'full'
                ? 'rounded-xl bg-accent text-white hover:bg-accent-hot'
                : 'rounded-lg border border-accent bg-accent/15 text-accent hover:bg-accent/25'
            }`}
          >
            <Square size={14} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() && attachments.length === 0}
            aria-label={t.brainChat.send}
            className={`flex h-9 w-9 shrink-0 items-center justify-center transition-colors disabled:opacity-40 ${
              variant === 'full'
                ? 'rounded-xl bg-accent text-white hover:bg-accent-hot'
                : 'rounded-lg border border-accent bg-accent/15 text-accent hover:bg-accent/25'
            }`}
          >
            <Send size={16} aria-hidden />
          </button>
        )}
      </form>
      </div>
      )}
      </div>
    </div>
  );
}
