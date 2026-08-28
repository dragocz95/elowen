'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Send, Square, Plus, ChevronDown, Paperclip, X, FileText, Download, Users, ChevronRight, PanelLeft, Brain, Activity, Pencil, MoreHorizontal, ListChecks, Clock3, ImageOff } from 'lucide-react';
import { toolGlyph } from '../../lib/toolGlyph';
import { usePersistentState } from '../../lib/usePersistentState';
import { interpolate, plural, useTranslation } from '../../lib/i18n';
import { useDismiss } from '../../lib/useDismiss';
import { useBrand } from '../../lib/brand';
import type { LocaleDict } from '../../lib/i18n/types';
import { useMobileViewport } from '../../lib/useMobile';
import { useToast } from '../../components/ui/Toast';
import type { BrainCard, BrainMessageFile, BrainMessageImage, BrainWorkMode } from '../../lib/types';
import { groupToolItems, type ChatTurn, type SessionEventItem, type ToolItem } from '../../lib/transcript';
import { MorePill } from '../../components/ui/MorePill';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button, buttonClassName } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { AskQuestionCard } from './AskQuestionCard';
import { AgentsTable } from './AgentsTable';
import { StatsModal } from './StatsModal';
import { ReasoningModal } from './ReasoningModal';
import { SkillsModal } from './SkillsModal';
import { TasksModal } from './TasksModal';
import { HelpModal } from './HelpModal';
import { ModelModal } from './ModelModal';
import { PlanDecisionModal } from './PlanDecisionModal';
import { ChatHistoryRail } from './ChatHistoryRail';
import { ModelPicker } from './ModelPicker';
import { ProjectPicker } from './ProjectPicker';
import { useBrainChat } from './BrainChatProvider';
import { formatBytes, formatTokens, formatCost, formatDuration, localDateTime } from '../../lib/format';
import { Spinner } from '../../components/ui/states';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';
import { isBackgroundProcessCardId } from '../../lib/processScope';
import {
  DEFAULT_COMPOSE_MARKER_MS,
  DEFAULT_LONG_TOOL_COMPOSE_MARKER_MS,
  LONG_COMPOSE_TOOLS,
  TODO_PREVIEW_ITEMS,
  composingLabel,
  todoPreviewItems,
  type ComposeLocale,
} from '../../lib/chatPresentation';

const STATUSLINE_VALUES = ['shown', 'hidden'] as const;

/** Sanitized-markdown block for one assistant text segment (marked + DOMPurify, no bubble). */
function TextSegment({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`chat-markdown text-sm leading-relaxed text-text ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** How many rows of a diff are shown before the rest folds away behind the expander. */
const DIFF_MAX_ROWS = 60;
/** How many trailing lines of a running command's live output tail to show (mirror of the CLI). */
const PROGRESS_TAIL_ROWS = 8;
/** A diff row is `-   12 text` (current pi-compatible format), `  12 - text` (legacy stored rows),
 *  or a bare unified `-text`/`+text`. */
const DIFF_SIGN = /^([+-])\s*\d+ |^\s*\d+ ([-+ ]) |^([-+])/;

/** An edit's display diff, Claude-Code style: a coloured left gutter per row (added green, removed red,
 *  context muted), no frame and no horizontal scroll — long lines wrap under the gutter so nothing is
 *  clipped or hidden behind a scrollbar.
 *
 *  A diff longer than the preview folds behind the shared expander instead of being cut off for good: the
 *  rest of an edit is exactly what a reader checking the change needs, and the transcript is the only
 *  place it is shown. Expanded, the block scrolls within its own bounded height rather than growing
 *  without limit, so a thousand-line edit still cannot take over the viewport on a phone. */
function DiffBlock({ diff }: { diff: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const lines = diff.replace(/\n+$/, '').split('\n');
  const hiddenRows = Math.max(0, lines.length - DIFF_MAX_ROWS);
  return (
    <div className="my-1 overflow-hidden rounded-md bg-elevated/40 py-1">
      <div
        id={bodyId}
        data-testid="chat-diff"
        className={expanded ? 'max-h-[60dvh] overflow-y-auto' : ''}
        // A scrollable region has to be reachable by keyboard alone, and it only scrolls when expanded.
        tabIndex={expanded ? 0 : undefined}
        role={expanded ? 'group' : undefined}
        aria-label={expanded ? t.brainChat.diffLabel : undefined}
      >
        {(expanded ? lines : lines.slice(0, DIFF_MAX_ROWS)).map((l, i) => {
          const m = DIFF_SIGN.exec(l);
          const sign = m?.[1] ?? m?.[2] ?? m?.[3];
          const cls = sign === '+' ? 'border-success/50 bg-success/10 text-success'
            : sign === '-' ? 'border-danger/50 bg-danger/10 text-danger'
            : 'border-transparent text-text-muted';
          return <div key={i} className={`whitespace-pre-wrap break-words border-l-2 px-2 ${cls}`}>{l || ' '}</div>;
        })}
      </div>
      {hiddenRows > 0 ? (
        <div className="px-2 pt-1">
          <MorePill
            expanded={expanded}
            hidden={hiddenRows}
            onToggle={() => setExpanded((v) => !v)}
            controls={bodyId}
            // The pill's own "+N more" repeats across every diff in the transcript; spell out what this
            // one unfolds for a reader who only hears the button.
            label={expanded ? t.brainChat.diffCollapse : t.brainChat.diffExpand.replace('{n}', String(hiddenRows))}
          />
        </div>
      ) : null}
    </div>
  );
}

function ToolOutputBlock({ output }: { output: NonNullable<ToolItem['output']> }) {
  const { t } = useTranslation();
  // A truncated output offers the full text as a real toggle, not a broken promise of a terminal that
  // was never wired up — flip between the preview and the full body in place.
  const [expanded, setExpanded] = useState(false);
  const hasFull = !!output.fullText && output.fullText !== output.text;
  const tone = output.tone === 'warning' || output.tone === 'danger'
    ? 'bg-warning/10 text-warning'
    : output.tone === 'success'
      ? 'bg-success/10 text-success'
      : 'bg-elevated/40 text-text-muted';
  return (
    <div data-testid="chat-tool-output" className={`my-1 overflow-hidden whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 ${tone}`}>
      {output.command ? <div className="text-text">$ {output.command}</div> : null}
      {/* Working directory lifted out of the console framing — faint context under the command echo. */}
      {output.cwd ? <div className="opacity-60">({t.brainChat.eventCwd}: {output.cwd})</div> : null}
      {output.status ? <div className="opacity-80">{output.status}</div> : null}
      <div>{(expanded && output.fullText ? output.fullText : output.text) || ' '}</div>
      {/* Hook-appended annotations (the `tools.call.after` contract, e.g. "formatted a.ts with prettier") —
          faint suffix lines under the output body, matching how the daemon renders ToolOutputView.notes. */}
      {output.notes?.length ? (
        <div className="mt-1 flex flex-col gap-0.5 opacity-70">
          {output.notes.map((n, i) => <div key={i}>↳ {n}</div>)}
        </div>
      ) : null}
      {hasFull ? (
        <button
          type="button"
          data-testid="chat-tool-output-expand"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 opacity-70 underline-offset-2 hover:underline"
        >
          {expanded ? t.brainChat.toolOutputCollapse : t.brainChat.toolOutputExpand}
        </button>
      ) : null}
    </div>
  );
}

/** A display card (ctx.emitCard) — the web mirror of the CLI/Discord panel: a clickable title row with a
 *  done/total count that collapses the card, a checklist (done struck through + green, in-progress
 *  accented, pending muted) previewed to its first items, and an optional freeform body. The todo
 *  checklist is the canonical card. A checklist with everything ticked leaves the transcript entirely —
 *  the CLI panel drops it the same way, because a finished list has nothing left to track. */
export function CardBlock({ card, live }: { card: BrainCard; live: boolean }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const items = card.items ?? [];
  const ticking = live && items.some((item) => item.status === 'in_progress' && Number.isFinite(item.startedAt));
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);
  const done = items.filter((i) => i.status === 'completed').length;
  if (items.length > 0 && done === items.length) return null;
  const previewable = items.length > TODO_PREVIEW_ITEMS;
  const shown = collapsed ? [] : previewable && !expanded ? todoPreviewItems(items, TODO_PREVIEW_ITEMS) : items;
  return (
    <div data-testid="chat-card" className="flex flex-col leading-relaxed">
      {(card.title || items.length > 0) ? (
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-1.5 text-left text-text-muted transition-colors hover:text-text"
        >
          <ChevronRight size={11} aria-hidden className={`shrink-0 opacity-60 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <span className="truncate">{card.title ?? t.brainChat.cardFallback}</span>
          {items.length > 0 ? <span className="tabular-nums opacity-70">{done}/{items.length}</span> : null}
        </button>
      ) : null}
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {shown.map((titem, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={`shrink-0 ${titem.status === 'completed' ? 'text-success' : titem.status === 'in_progress' ? 'text-accent' : 'text-text-muted'}`}>
                {titem.status === 'completed' ? '✔' : titem.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className={titem.status === 'completed' ? 'text-text-muted line-through' : 'text-text'}>
                {titem.text}
                {titem.status === 'in_progress' && Number.isFinite(titem.startedAt) ? (
                  <span data-testid="chat-card-elapsed" className="ml-1 tabular-nums text-text-muted opacity-70">· {formatDuration(now - titem.startedAt!)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {!collapsed && previewable ? (
        <div className="mt-1">
          <MorePill expanded={expanded} hidden={items.length - TODO_PREVIEW_ITEMS} onToggle={() => setExpanded((v) => !v)} />
        </div>
      ) : null}
      {!collapsed && card.body ? <div className="whitespace-pre-wrap break-words text-text-muted">{card.body}</div> : null}
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
function ToolPills({ tools, full, live }: { tools: ToolItem[]; full?: boolean; live?: boolean }) {
  const { t } = useTranslation();
  // Consecutive calls of the same tool fold into ONE row carrying a `×N` count (the CLI's grouped pills);
  // recomputed every render so a streaming run's count and latest argument stay live.
  const groups = groupToolItems(tools);
  return (
    <div className={`flex flex-col pl-4 font-mono leading-relaxed ${full ? 'text-[0.6875rem]' : 'text-tiny'}`}>
      {groups.map((group, i) => {
        const tool = group.item;
        // A submitted plan REPLACES its tool row: the row would say only "ExitPlanMode", which tells the
        // reader nothing the panel does not say better.
        if (tool.plan) return <PlanBlock key={i} plan={tool.plan} />;
        const rich = !!(tool.diff || tool.output || tool.progress);
        // The tail call of a still-streaming turn that has settled neither a diff nor an output is the one
        // currently executing — the web twin of the CLI's spinner row.
        const running = !!live && i === groups.length - 1 && !tool.output && !tool.diff;
        const head = (
          <>
            {running
              ? <Spinner size="xs" tone="text-warning" label={t.brainChat.toolRunning} />
              : <span aria-hidden className="shrink-0 select-none opacity-70">{toolGlyph(tool.name)}</span>}
            <span className="shrink-0 text-text-muted">{tool.name}</span>
            {tool.detail ? <span className="truncate opacity-60">{tool.detail}</span> : null}
            {group.count > 1 ? <span className="shrink-0 tabular-nums opacity-50">×{group.count}</span> : null}
          </>
        );
        if (!rich) {
          return <div key={i} data-testid="chat-tool-pill" data-tool-id={tool.id} className="flex items-center gap-1.5 py-0.5 text-text-muted">{head}</div>;
        }
        return (
          <details key={i} data-testid="chat-tool-pill" data-tool-id={tool.id} className="chat-tool">
            <summary className="flex cursor-pointer items-center gap-1.5 rounded py-0.5 text-text-muted transition-colors hover:text-text">
              {head}
              <ChevronRight size={11} aria-hidden className={`chat-tool__chev shrink-0 opacity-40 ${full ? '' : 'ml-auto'}`} />
            </summary>
            <div className="pb-0.5">
              {tool.diff ? <DiffBlock diff={tool.diff} /> : null}
              {/* A folded run of identical FAILURES keeps every member: the rows read alike, but each one
                  names the path it refused, so the expanded block lists them all. */}
              {group.members
                ? group.members.map((member, j) => (member.output ? <ToolOutputBlock key={j} output={member.output} /> : null))
                : tool.output ? <ToolOutputBlock output={tool.output} /> : null}
              {tool.progress ? <ProgressBlock text={tool.progress} /> : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** A plan submitted through `ExitPlanMode`, rendered as a labelled panel in place of the tool row. It is
 *  the turn's actual deliverable — a document the user reads and decides on — so unlike a diff or a
 *  command output it is never collapsed behind a chevron. The body stays plain text: it comes off disk
 *  and out of whatever the model read, so it is displayed, never interpreted. */
function PlanBlock({ plan }: { plan: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="chat-plan" className="my-1 overflow-hidden rounded-md border border-border bg-surface-muted">
      <div className="border-b border-border px-2.5 py-1 text-tiny uppercase tracking-wide text-text-muted">
        {t.brainChat.proposedPlan}
      </div>
      <div className="whitespace-pre-wrap break-words px-2.5 py-1.5 text-text">{plan}</div>
    </div>
  );
}

/** One reasoning segment, the web twin of the CLI's "Thought: 12s" row: a collapsible block whose header
 *  carries how long the model has been thinking. It stays open while it streams and folds itself away once
 *  the turn settles — unless the reader has toggled it, in which case their choice wins for good. The
 *  elapsed time is measured here (the wire carries no timing), so it exists only for a segment this tab
 *  actually watched stream; a rehydrated one simply shows the time it spent mounted. */
function ReasoningBlock({ text, live, full }: { text: string; live: boolean; full?: boolean }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<'auto' | 'open' | 'closed'>('auto');
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = (): void => setElapsed(Date.now() - startRef.current);
    tick(); // settling freezes the timer on the exact elapsed time, not on the last whole second
    if (!live) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [live]);
  const open = choice === 'auto' ? live : choice === 'open';
  // A button + conditional body rather than <details>: the open state is driven by the stream (it folds
  // itself when the turn settles), and a details element owns its own toggling, which fights that.
  return (
    <div data-testid="chat-thought" className={full ? 'my-1.5' : ''}>
      <button
        type="button"
        onClick={() => setChoice(open ? 'closed' : 'open')}
        aria-expanded={open}
        className={`flex items-center gap-1.5 text-text-muted transition-colors hover:text-text ${full ? 'text-xs' : 'text-tiny'}`}
      >
        <ChevronRight size={11} aria-hidden className={`shrink-0 opacity-40 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{t.brainChat.reasoningLabel}</span>
        <span className="tabular-nums opacity-60">{formatDuration(elapsed)}</span>
      </button>
      {open ? <p className={`whitespace-pre-wrap break-words border-l-2 border-border pl-2 italic text-text-muted ${full ? 'text-xs' : 'text-tiny'}`}>{text}</p> : null}
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
    <div data-testid="chat-turn" data-role="divider" className={`flex items-center gap-2 text-tiny text-text-muted ${full ? 'my-5' : 'my-1'}`} role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span data-testid="chat-divider" className="shrink-0 uppercase tracking-wide">{t.brainChat.contextCompacted}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** A sub-agent finish marker's detail is small JSON (mirror of the daemon `parseSubagentMarker`). Parse
 *  defensively: a malformed row falls back to the raw string rather than throwing on a render path. */
function parseSubagentMarker(detail: string): { task: string; status: string } | null {
  try {
    const raw: unknown = JSON.parse(detail);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.status !== 'string') return null;
    return { task: typeof obj.task === 'string' ? obj.task : '', status: obj.status };
  } catch { return null; }
}

/** A workflow finish marker's detail is small JSON (mirror of the daemon `parseWorkflowMarker`). */
function parseWorkflowMarker(detail: string): { title: string; status: string; ran: number; total: number } | null {
  try {
    const raw: unknown = JSON.parse(detail);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.status !== 'string' || typeof obj.ran !== 'number' || typeof obj.total !== 'number') return null;
    return { title: typeof obj.title === 'string' ? obj.title : '', status: obj.status, ran: obj.ran, total: obj.total };
  } catch { return null; }
}

/** Phrase a session-change marker — mirror of the daemon `sessionEventLabel` (src/cli/chat/turnRenderer.ts).
 *  A `cwd` path is shortened to its last two segments (the web has no absolute-path context). */
function eventLabel(kind: string, detail: string, t: LocaleDict): string {
  switch (kind) {
    case 'model': return `${t.brainChat.eventModel} → ${detail}`;
    case 'mode': return `${t.brainChat.eventMode} → ${detail}`;
    case 'rename': return `${t.brainChat.eventRenamed} → "${detail}"`;
    case 'reasoning': return `reasoning → ${detail}`;
    case 'cwd': return `${t.brainChat.eventCwd} → …/${detail.split('/').filter(Boolean).slice(-2).join('/')}`;
    case 'subagent': {
      const marker = parseSubagentMarker(detail);
      if (!marker) return detail;
      const verb = marker.status === 'error' ? t.brainChat.eventSubagentFailed : t.brainChat.eventSubagentDone;
      return marker.task ? `${verb} · ${marker.task}` : verb;
    }
    case 'workflow': {
      const marker = parseWorkflowMarker(detail);
      if (!marker) return detail;
      const verb = marker.status === 'error' ? t.brainChat.eventWorkflowFailed
        : marker.status === 'cancelled' ? t.brainChat.eventWorkflowStopped : t.brainChat.eventWorkflowDone;
      const tally = `${marker.ran}/${marker.total} ${t.brainChat.eventNodes}`;
      return marker.title ? `${verb} · ${marker.title} · ${tally}` : `${verb} · ${tally}`;
    }
    default: return detail;
  }
}

/** A run of session-change markers (model/mode/rename/cwd) — the machine annotating what it did, rendered
 *  as one faint line per marker, the web twin of the CLI's dim `⚙` event rows. */
function SessionEvents({ events, tk }: { events: SessionEventItem[]; tk?: string }) {
  const { t } = useTranslation();
  return (
    <div data-tk={tk} data-testid="chat-turn" data-role="event" className="flex flex-col gap-0.5 py-1 text-tiny text-text-muted">
      {events.map((e) => (
        <div key={e.id || `${e.kind}:${e.detail}`} data-testid="chat-event-marker" className="flex items-center gap-1.5">
          <span aria-hidden className="shrink-0 opacity-60">⚙</span>
          <span className="truncate">{eventLabel(e.kind, e.detail, t)}</span>
        </div>
      ))}
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
/** A user turn's surviving attachments. The daemon kept the files next to its database, so these render
 *  identically from the live stream and from reloaded history — the whole point of storing them. The
 *  `<img>` hits the same-origin proxy, which turns the session cookie into the daemon bearer, so no
 *  signed link is involved. Clicking opens the full-size file in a new tab. */
function Attachments({ images, full }: { images: BrainMessageImage[]; full?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-2 ${full ? 'my-1.5' : 'mt-1.5'}`}>
      {images.map((image) => <AttachmentThumb key={image.url} image={image} />)}
    </div>
  );
}

/** One attachment, with an answer for the case where the bytes are gone. A stored picture can stop
 *  resolving — the daily sweep reclaims files nothing references any more, and a transcript opened
 *  read-only asks for an image the daemon will only serve to its owner (a 404 by design, so the request
 *  cannot be used to probe what other conversations hold). The browser's own reply to that is a broken
 *  image glyph, which reads as "the chat is buggy" rather than "this picture is no longer here". State it
 *  instead, and drop the click-through: a link to a 404 is worse than no link. */
function AttachmentThumb({ image }: { image: BrainMessageImage }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-2 text-xs text-text-muted">
        <ImageOff size={14} className="shrink-0" aria-hidden />
        {t.brainChat.attachmentGone}
      </span>
    );
  }
  return (
    <a
      href={`/api${image.url}`}
      target="_blank"
      rel="noreferrer"
      title={t.brainChat.attachmentOpen}
      className="block overflow-hidden rounded-lg border border-border transition-colors hover:border-accent"
    >
      <img
        src={`/api${image.url}`}
        alt={t.brainChat.attachmentAlt}
        onError={() => setFailed(true)}
        className="max-h-48 max-w-[min(16rem,100%)] object-contain"
      />
    </a>
  );
}

/** An image the agent shared on purpose (`ShareImage`). It is the same picture-in-the-conversation the
 *  user's own attachments are — same proxy path, same click-through to full size — so it reuses
 *  {@link Attachments} rather than growing a second thumbnail. Only the caption underneath is its own. */
function SharedImage({ image, caption, full }: { image: BrainMessageImage; caption?: string; full?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <Attachments images={[image]} full={full} />
      {caption ? <div className="mt-1 text-xs leading-relaxed text-text-muted">{caption}</div> : null}
    </div>
  );
}

/** A file the agent handed over via ShareFile. The filename and size explain what will be fetched, while the
 *  shared button styling makes the action unmistakable without inventing a one-off control. */
function SharedFile({ file, caption, full }: { file: BrainMessageFile; caption?: string; full?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-elevated/50 p-3 ${full ? 'my-1.5' : ''}`} data-testid="shared-file">
      <div className="flex min-w-0 items-center gap-2.5">
        <FileText size={20} className="shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text" title={file.name}>{file.name}</div>
          <div className="text-xs text-text-muted">{formatBytes(file.size)}</div>
        </div>
        <a
          href={`/api${file.url}`}
          download={file.name}
          className={buttonClassName('default', 'h-8 shrink-0 px-3')}
          aria-label={`${t.brainChat.fileDownload}: ${file.name}`}
        >
          <Download size={14} aria-hidden />
          {t.brainChat.fileDownload}
        </a>
      </div>
      {caption ? <div className="text-xs leading-relaxed text-text-muted">{caption}</div> : null}
    </div>
  );
}

/** Settled-turn metadata: when the turn ended and how long it took.
 *
 *  One visible reply is MANY assistant messages — the agent writes one per tool round — and every one of
 *  them carries its own `createdAt`. Stamping each turn therefore printed the same date+time above every
 *  single tool row. The daemon marks the run's LAST assistant row alone with `turn_duration_ms`
 *  (store/schema.sql), and that is exactly the marker the CLI gates its own settled meta on
 *  (src/cli/chat/turnRenderer.ts) — so keying off it puts one stamp at the end of the turn on both
 *  surfaces instead of inventing a second, web-only notion of where a turn ends. A still-streaming turn
 *  has not ended yet and carries no duration, so it stays unstamped until it settles.
 *
 *  A user message is a turn of its own, so it is stamped from its own `createdAt` whenever history
 *  carries one. */
function MessageMeta({ turn }: { turn: Extract<ChatTurn, { role: 'you' | 'elowen' }> }) {
  const { locale, t } = useTranslation();
  const settled = turn.role === 'elowen' ? turn.durationMs != null : Boolean(turn.createdAt);
  if (!settled) return null;
  return (
    <div data-testid="chat-turn-meta" className="chat-turn-meta mt-1 flex items-center gap-2 text-[10px] leading-none text-text-muted/70">
      {turn.createdAt ? <time dateTime={turn.createdAt}>{localDateTime(turn.createdAt, locale, false)}</time> : null}
      {turn.role === 'elowen' && turn.model ? (
        <span data-testid="chat-turn-model" className="inline-flex min-w-0 items-center gap-1" title={turn.model}>
          <ModelIcon name={turn.model} size={10} />
          <span className="max-w-48 truncate">{brainModelQualifiedLabel(turn.model)}</span>
        </span>
      ) : null}
      {turn.role === 'elowen' && turn.durationMs != null ? (
        <span className="inline-flex items-center gap-1" title={t.brainChat.turnDuration}>
          <Clock3 size={10} aria-hidden />
          {formatDuration(turn.durationMs)}
        </span>
      ) : null}
    </div>
  );
}

function ToolAuthoringHint({ turn, locale }: {
  turn: Extract<ChatTurn, { role: 'elowen' }>;
  locale: ComposeLocale;
}) {
  const { t } = useTranslation();
  const startedAt = useRef(Date.now());
  const [ready, setReady] = useState(false);
  const threshold = turn.composingTool && LONG_COMPOSE_TOOLS.has(turn.composingTool)
    ? DEFAULT_LONG_TOOL_COMPOSE_MARKER_MS
    : DEFAULT_COMPOSE_MARKER_MS;

  useEffect(() => {
    const remaining = Math.max(0, threshold - (Date.now() - startedAt.current));
    if (remaining === 0) { setReady(true); return; }
    setReady(false);
    const timer = setTimeout(() => setReady(true), remaining);
    return () => clearTimeout(timer);
  }, [threshold]);

  if (!turn.streaming || !turn.composing || !ready) return null;
  const label = composingLabel(turn.composingReason, turn.composingTool, turn.composingDetail, locale)
    ?? turn.composingTool
    ?? t.brainChat.toolRunning;
  return (
    <div data-testid="chat-tool-authoring" role="status" aria-live="polite" className="flex items-center gap-1.5 py-0.5 pl-4 font-mono text-text-muted">
      <Spinner size="xs" tone="text-warning" />
      <span className="truncate italic opacity-80">{label}</span>
    </div>
  );
}

function Message({ turn, full, showRole, showThoughts, tk }: { turn: ChatTurn; full?: boolean; showRole?: boolean; showThoughts: boolean; tk?: string }) {
  const { t, locale } = useTranslation();
  const { agentName } = useBrand();
  if (turn.role === 'divider') return <ContextDivider full={full} />;
  if (turn.role === 'event') return <SessionEvents events={turn.events} tk={tk} />;

  const you = turn.role === 'you';
  const roleAttr = you ? 'you' : 'assistant';
  const body = turn.role === 'you'
    ? <div className="chat-user-message">
        {turn.text.trim() ? <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-text ${full ? '' : 'my-1.5'}`}>{turn.text}</div> : null}
        {turn.images?.length ? <Attachments images={turn.images} full={full} /> : null}
      </div>
    : <>{turn.segments.map((seg, i) => (seg.kind === 'text'
        ? <TextSegment key={i} text={seg.text} className={full ? 'my-1.5' : ''} />
        : seg.kind === 'reasoning'
        ? (showThoughts ? <ReasoningBlock key={i} text={seg.text} full={full} live={turn.streaming && i === turn.segments.length - 1} /> : null)
        : seg.kind === 'image'
        ? <SharedImage key={i} image={seg.image} caption={seg.caption} full={full} />
        : seg.kind === 'file'
        ? <SharedFile key={i} file={seg.file} caption={seg.caption} full={full} />
        : <ToolPills key={i} tools={seg.items} full={full} live={turn.streaming && i === turn.segments.length - 1} />))}
        {turn.composing ? <ToolAuthoringHint turn={turn} locale={locale as ComposeLocale} /> : null}
      </>;

  if (full) {
    return (
      <div data-tk={tk} data-testid="chat-turn" data-role={roleAttr} className={`chat-turn chat-turn--${roleAttr} grid grid-cols-[16px_1fr] gap-x-3 ${showRole ? 'mt-6 first:mt-0' : ''}`}>
        {showRole ? (
          <span aria-hidden className={`chat-turn__marker mt-1.5 h-2 w-2 rounded-full ${you ? 'bg-accent ring-4 ring-accent/15' : 'bg-text-muted'}`} />
        ) : <span aria-hidden className="chat-turn__marker" />}
        <div className="chat-turn__column min-w-0">
          {showRole ? <div className={`chat-turn__role mb-0.5 text-xs font-semibold ${you ? 'text-accent' : 'text-text-muted'}`}>{you ? t.chat.roleYou : interpolate(t.chat.roleElowen, { agentName })}</div> : null}
          <div className="chat-turn__body flex min-w-0 flex-col">{body}</div>
          <MessageMeta turn={turn} />
        </div>
      </div>
    );
  }

  if (you) {
    return (
      <div data-tk={tk} data-testid="chat-turn" data-role={roleAttr} className="ml-8 flex max-w-full flex-col items-end self-end">
        <div className="whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
          {turn.role === 'you' ? turn.text : null}
          {turn.role === 'you' && turn.images?.length ? <Attachments images={turn.images} /> : null}
        </div>
        <MessageMeta turn={turn} />
      </div>
    );
  }
  return <div data-tk={tk} data-testid="chat-turn" data-role={roleAttr} className="mr-4 flex flex-col gap-1.5 self-start">{body}<MessageMeta turn={turn} /></div>;
}

/** Opens the conversation's reasoning controls. The historic test id stays stable for browser helpers,
 *  but this is no longer a second display toggle: the button and `/reasoning` open the same modal. */
function ReasoningButton({ full, onOpen }: { full?: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-testid="chat-thoughts-toggle"
      onClick={onOpen}
      aria-label={t.reasoning.modalTitle}
      title={t.reasoning.modalTitle}
      className={`flex shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text ${
        full ? 'h-8 w-8' : 'h-7 w-7'
      }`}
    >
      <Brain size={full ? 18 : 16} aria-hidden />
    </button>
  );
}

/** Which work mode the next send is stamped with. Rendered only OUTSIDE build mode: build is the default
 *  every conversation starts in, so a permanent "Build" chip would be noise — while plan/workflow change
 *  what the agent may do and must never be a hidden switch. */
function WorkModePill({ mode, full }: { mode: BrainWorkMode; full?: boolean }) {
  const { t } = useTranslation();
  if (mode === 'build') return null;
  return (
    <span
      data-testid="chat-work-mode"
      title={t.brainChat.workModeLabel}
      className={`shrink-0 rounded-md border border-accent/40 bg-accent/10 px-1.5 font-medium uppercase tracking-wide text-accent ${full ? 'py-0.5 text-tiny' : 'py-px text-[0.625rem]'}`}
    >
      <span className="sr-only">{t.brainChat.workModeLabel}: </span>{t.brainChat.workMode[mode]}
    </span>
  );
}

/** Phone-only overflow for the conversation bar: on a narrow screen the bar can't hold the model picker
 *  and work-mode pill inline without cramming, so they fold behind one ⋯ button. The reasoning button is
 *  deliberately NOT here — it is changed often enough that burying it behind two taps was the complaint.
 *  A transient popover (outside-pointer / Escape dismiss, same grammar as ModelPicker), never a persistent
 *  panel. Desktop keeps every control inline and never mounts this. */
function BarOverflowMenu({ workMode, hasTodos, onOpenTodos }: {
  workMode: BrainWorkMode; hasTodos: boolean; onOpenTodos: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  const rowClass = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text transition-colors hover:bg-bg';
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t.chat.moreOptions}
        title={t.chat.moreOptions}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      {/* A plain popover, NOT `role="menu"`: that role promises menuitem children and arrow-key roving
          focus, and this popover leads with the model picker — a composite control, not a menu row — so
          the promise was one a screen reader could not cash. */}
      {open ? (
        <div data-chat-popover className="absolute right-0 z-20 mt-1 flex w-60 flex-col gap-0.5 rounded-lg border border-border bg-elevated p-1.5 shadow-lg">
          {/* The picker is the menu's heading — it is a control, not a menu row, so it reads wrong pushed
              below one. Plain rows follow it. */}
          <div className="px-1 pb-1"><ModelPicker variant="full" /></div>
          {/* Where the agent works belongs beside what it is: the phone folds both away, so both come back
              here rather than leaving the directory reachable only on a desktop. */}
          <div className="px-1 pb-1"><ProjectPicker variant="full" /></div>
          {/* The narrow bar has no room for a TODO control of its own, so the menu is the way to reach it. */}
          {hasTodos ? (
            <button type="button" onClick={() => { setOpen(false); onOpenTodos(); }} className={rowClass}>
              <ListChecks size={16} className="text-text-muted" aria-hidden />
              <span>{t.chat.todos}</span>
            </button>
          ) : null}
          {workMode !== 'build' ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-text-muted">
              <span>{t.brainChat.workModeLabel}:</span><WorkModePill mode={workMode} full />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The `/rename` dialog: the conversation's title prefilled, committed with Enter or the save button. The
 *  web twin of the CLI's rename prompt — the history rail renames inline, this renames the OPEN chat. */
function RenameDialog({ current, onClose, onSubmit }: { current: string; onClose: () => void; onSubmit: (title: string) => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(current);
  const commit = () => { if (title.trim()) onSubmit(title); };
  return (
    <Modal title={t.brainChat.renameTitle} onClose={onClose} size="sm" icon={Pencil}>
      <ModalBody>
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          aria-label={t.chat.renamePlaceholder}
          placeholder={t.chat.renamePlaceholder}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="accent" disabled={!title.trim()} onClick={commit}>{t.common.save}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** The presentational brain chat surface, driven entirely by the shared controller (BrainChatProvider)
 *  read from context. It owns NO network or session state: only pure view affordances (the picker-open
 *  toggle, the slash keyboard cursor, DOM refs + autoscroll) live here, so unmounting it (Chat↔Terminál
 *  toggle, route change) never tears down the stream, draft or transcript. The conversation list / search
 *  / rename / export / delete are the shared ChatHistoryRail. `variant` selects the dock (compact) look or
 *  the wide /chat (full) look; `onOpenHistory` opens the mobile history drawer in the full variant, and
 *  `onOpenTelemetry` the telemetry drawer — the host passes the latter only where the rail cannot be a
 *  column (a phone), so on desktop no button appears beside the permanently visible rail. */
export function BrainChatSurface({ variant = 'compact', onOpenHistory, onOpenTelemetry, telemetryShown }: { variant?: 'compact' | 'full'; onOpenHistory?: () => void; onOpenTelemetry?: () => void; telemetryShown?: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const c = useBrainChat();
  const {
    turns, busy, ready, notice, ask, cards, agentsOpen, setAgentsOpen, statsOpen, setStatsOpen,
    reasoningOpen, setReasoningOpen, skillsOpen, setSkillsOpen, tasksOpen, setTasksOpen, helpOpen, setHelpOpen, modelOpen, setModelOpen, queued, readOnly,
    usage, lineCfg, currentModel, provider, subagents, input, setInput, attachments, addFiles, removeAttachment, submit, switchSession,
    openReadOnly, exitReadOnly, onQueueRemove, onAnswer, slash, sessions, activeSessionId, focusNonce,
    ensureAttached, abort, loadOlder, hasMoreHistory, showThoughts,
    workMode, planDecision, implementPlan, dismissPlan, planSubmitting, renameOpen, closeRename, renameSession,
    registerSurface,
  } = c;

  // Tell the provider a chat is on screen. It sits above every route, so the reconnect overlay it owns
  // must only cover the app while there is actually a conversation to protect — not while the reader is
  // on the dashboard.
  useEffect(() => registerSurface(), [registerSurface]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  // Whether the statusline row (model / context / tokens / cost) is shown is a per-device display choice —
  // it belongs to the screen you are on, not the user record. Collapsing it in-chat (a small chevron) is
  // the quick alternative to the statusline plugin's settings toggles.
  const [statuslinePref, setStatuslinePref] = usePersistentState<'shown' | 'hidden'>('elowen.chat.statusline', 'shown', STATUSLINE_VALUES);
  const statuslineShown = statuslinePref === 'shown';
  // Running agents are reported in exactly ONE place. The docked rail lists them (and drills into them), so
  // while it is open the in-transcript chip is redundant — the same work was being announced twice.
  // `telemetryShown` is undefined wherever there is no docked rail (the compact dock, and a phone where the
  // rail is a drawer), so only an actually-visible rail takes ownership; hidden or absent hands the
  // reporting back to the transcript rather than dropping it.
  const railOwnsLiveWork = telemetryShown === true;
  // `undefined` until the viewport has actually been measured. Every branch below therefore tests `=== true`
  // or `=== false` and renders NOTHING in between: the boolean-returning hook reports `false` first, which
  // on a phone painted one frame of the desktop controls (inline picker, mode pill, reasoning button) before
  // swapping them for the ⋯ menu. A bar that is briefly missing a control is quieter than one that visibly
  // rearranges itself. Same approach as ChatView, which reads this hook for its own layout.
  const mobile = useMobileViewport();
  // The transcript's out-of-band extras (TODO cards, agents chip) wait for the measurement too: rendering
  // them while the viewport is still unknown paints them once on a phone before the layout resolves.
  const transcriptExtras = mobile !== undefined;
  // TODO cards with open work (CardBlock hides a card whose every item is done). The phone bar has no room
  // for a control of its own, so the ⋯ menu opens them in a dialog instead.
  const todoCards = cards.filter((cd) => {
    if (isBackgroundProcessCardId(cd.id)) return false;
    const items = cd.items ?? [];
    return items.length === 0 ? true : !items.every((i) => i.status === 'completed');
  });
  const [todosOpen, setTodosOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Lazy-load (scroll-up) state. `loadingOlder` drives the top spinner; `atBottomRef` tracks whether the
  // reader is pinned to the newest turn (so a streaming delta doesn't yank them down while they read up).
  // The prepend anchor rides on a real turn ELEMENT: at scroll-trigger we grab the topmost turn node and its
  // offsetTop; after older turns land above it, we shift scrollTop by exactly how far that node moved. Node
  // offsetTop is immune to below-viewport growth (cards / ask / agents / process panel) and to a stream
  // delta landing during the fetch, both of which broke a scrollHeight-delta anchor.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const atBottomRef = useRef(true);
  const prevTurnsRef = useRef<ChatTurn[]>([]);
  const previousSessionRef = useRef<string | null>(activeSessionId);
  const anchorNodeRef = useRef<HTMLElement | null>(null);
  const anchorTopRef = useRef(0);

  // The element that actually scrolls the transcript: in the full page it is the shell <main> (the page
  // itself scrolls); the compact dock scrolls its own box. Every scroll read/write below goes through this
  // one resolver.
  const getScroller = useCallback((): HTMLElement | null => {
    const el = scrollRef.current;
    if (!el) return null;
    return variant === 'full' ? el.closest('main') : el;
  }, [variant]);

  // Grab the current topmost turn node as the prepend anchor, then fetch the next older page (the layout
  // effect restores its position once the page lands). Guarded so a burst of scroll events fires at most one
  // load at a time. Capturing the NODE (not a scroll scalar) is what survives the async fetch gap.
  const triggerOlder = useCallback((): void => {
    if (loadingOlder || !hasMoreHistory) return;
    const node = scrollRef.current?.querySelector<HTMLElement>('[data-tk]') ?? null;
    anchorNodeRef.current = node;
    anchorTopRef.current = node?.offsetTop ?? 0;
    setLoadingOlder(true);
    // A transient page-fetch failure leaves the cursor/hasMore untouched (next scroll-up retries) — swallow
    // it so it isn't an unhandled rejection, and always clear the spinner.
    void loadOlder().catch(() => { /* best-effort — retried on the next scroll-up */ }).finally(() => setLoadingOlder(false));
  }, [loadingOlder, hasMoreHistory, loadOlder]);
  // The scroll listener reads the trigger through a ref so it binds ONCE per scroller (not every render,
  // which the churny `loadOlder` identity would otherwise force).
  const triggerOlderRef = useRef(triggerOlder);
  triggerOlderRef.current = triggerOlder;

  const active = sessions.data?.find((s) => s.active);
  const runningAgents = subagents.filter((agent) => agent.status === 'running').length;
  // Index of the first live (id-less) turn — the boundary between stored history and the live streaming tail
  // used to key the tail stably across a lazy-load prepend (see the transcript map below).
  const firstLiveTurn = turns.findIndex((turn) => !turn.id);

  const slashItems = slash.items;
  const slashOpen = slash.open;
  const slashSel = Math.min(slashIdx, slashItems.length - 1);

  // First mount of ANY chat surface (dock opened in chat mode) lazily boots the controller. Idempotent —
  // a second mount (or the BRAIN_* window events) never re-runs brainStart, so a one-shot mount call is
  // enough (and avoids re-firing on the controller's per-render identity churn).
  useEffect(() => { ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening another conversation is an explicit request to see that conversation's newest message. Reset
  // every scroll/prepend guard before its snapshot lands; otherwise a chat opened while the previous one
  // was scrolled up inherited `atBottom=false` and rendered at the old page offset.
  useLayoutEffect(() => {
    if (!activeSessionId || activeSessionId === previousSessionRef.current) return;
    previousSessionRef.current = activeSessionId;
    atBottomRef.current = true;
    prevTurnsRef.current = [];
    anchorNodeRef.current = null;
    const s = getScroller();
    if (s) s.scrollTo({ top: s.scrollHeight });
  }, [activeSessionId, getScroller]);

  // Position the transcript after each turns change. A lazy-load PREPEND (older turns inserted in front —
  // detected by the previous head object reappearing below index 0) holds the viewport on the same content
  // by shifting scrollTop by exactly how far the anchored turn node moved down; every other change sticks to
  // the newest turn, but ONLY when the reader is already near the bottom — so scrolling up to read history
  // isn't yanked back down by an incoming streaming delta. Layout effect: the scroll write lands before
  // paint (no flicker).
  useLayoutEffect(() => {
    const s = getScroller();
    if (!s) { prevTurnsRef.current = turns; return; }
    const prev = prevTurnsRef.current;
    const oldHead = prev[0];
    const isPrepend = !!oldHead && turns.length > prev.length && turns.indexOf(oldHead) > 0;
    const anchor = anchorNodeRef.current;
    if (isPrepend) {
      // Only the prepend consumes the anchor — a stream delta landing in the fetch gap must NOT clear it,
      // or the real prepend that follows would jump.
      if (anchor) s.scrollTop += anchor.offsetTop - anchorTopRef.current;
      anchorNodeRef.current = null;
    } else if (atBottomRef.current) {
      s.scrollTo({ top: s.scrollHeight });
    }
    prevTurnsRef.current = turns;
  }, [turns, variant, getScroller]);

  // Watch the live scroll position: track "near the bottom" (the stick-to-newest gate above) and load the
  // next older page when the reader nears the top. Bound imperatively because the scroller is sometimes the
  // shell <main>, not a node this component renders; rebinds only when the resolver changes (variant) —
  // the trigger is read through a ref so a per-render identity can't churn the bind.
  useEffect(() => {
    const s = getScroller();
    if (!s) return;
    const onScroll = (): void => {
      atBottomRef.current = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
      if (s.scrollTop < 120) triggerOlderRef.current();
    };
    s.addEventListener('scroll', onScroll, { passive: true });
    return () => s.removeEventListener('scroll', onScroll);
  }, [getScroller]);

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

  // Grow the composer with its content up to the CSS cap, then let it scroll. `rows` used to be derived
  // from newline count, which ignores WRAPPING — a long message typed without pressing Enter stayed one
  // line tall and hid everything above the caret. Height has to be reset before reading scrollHeight, or
  // the box can only ever grow. This runs on `input` rather than on keystrokes so text placed by another
  // path (a recalled queue item, a restored draft, a `/`-prefilled macro) is measured too.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const keepNewestVisible = atBottomRef.current;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    // The full-page composer participates in the document height even though it is sticky. Grow it and
    // restore the bottom in the same layout phase, before paint, so wrapped lines do not visibly shove the
    // whole conversation upward one row at a time. A reader scrolled into history is left untouched.
    if (keepNewestVisible) {
      const s = getScroller();
      if (s) s.scrollTo({ top: s.scrollHeight });
    }
  }, [input, getScroller]);

  const newChat = () => { setPickerOpen(false); void switchSession({ fresh: true }).catch(() => toast(t.brainChat.searchOpenError, 'error')); };

  return (
    <div
      className={`relative flex flex-col ${variant === 'full' ? 'flex-1' : 'h-full min-h-0'}`}
      data-variant={variant}
    >
      {/* Conversation bar. Compact (dock): title + picker dropdown + new chat. Full (/chat): a light
          header — the shared history rail owns the session list, so here it is only the title, a mobile
          drawer toggle and new chat. */}
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
          <WorkModePill mode={workMode} />
          <ProjectPicker variant="compact" />
          <ModelPicker variant="compact" />
          <ReasoningButton onOpen={() => setReasoningOpen(true)} />
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
        <div className="chat-gutter sticky top-0 z-10 flex shrink-0 items-center gap-1.5 bg-bg py-2">
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
          {/* On a phone the model picker and work-mode pill fold into the ⋯ menu below; on desktop they
              stay inline. The pill is a security indicator (plan/workflow), so it also shows inline on
              desktop and, when non-build, inside the ⋯ menu on mobile. */}
          {mobile === false ? (
            <>
              <WorkModePill mode={workMode} full />
              <ProjectPicker variant="full" />
              <ModelPicker variant="full" />
            </>
          ) : null}
          {/* The reasoning button stays inline at EVERY width. It is the one control here that gets
              changed mid-conversation rather than set once, and two taps through ⋯ for something that
              frequent is what made the phone feel worse than the desktop. It is a single 8×8 icon, so
              the only thing it costs the narrow bar is a little more truncation of the title. */}
          <ReasoningButton full onOpen={() => setReasoningOpen(true)} />
          {onOpenTelemetry ? (
            <button
              type="button"
              onClick={onOpenTelemetry}
              // `telemetryShown` is absent where the rail is a drawer (a phone), so the control is a plain
              // opener; where the rail is a docked column it is a toggle, and the label has to say which
              // way it goes or a hidden rail looks like a broken one.
              aria-label={telemetryShown ? t.telemetry.close : t.telemetry.open}
              title={telemetryShown ? t.telemetry.close : t.telemetry.open}
              aria-pressed={telemetryShown}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
            >
              <Activity size={18} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={newChat}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <Plus size={18} aria-hidden />
          </button>
          {/* Desktop keeps the model/mode/thoughts controls inline above; a phone folds them behind ⋯. */}
          {mobile === true ? (
            <BarOverflowMenu
              workMode={workMode}
              hasTodos={todoCards.length > 0}
              onOpenTodos={() => setTodosOpen(true)}
            />
          ) : null}
        </div>
      )}

      {/* Messages. The full /chat variant flows full-width and lets the page scroll (no inner scroll box);
          turns stack with NO container gap — each segment carries its own margin, so tool rows keep one
          uniform rhythm across turn boundaries and only a speaker change opens a block break. The compact
          dock keeps its own internal scroll and per-turn gap. */}
      <div ref={scrollRef} data-testid="chat-transcript" className={`flex flex-1 flex-col ${variant === 'full' ? 'chat-gutter chat-transcript' : 'gap-3 min-h-0 overflow-y-auto p-3'}`}>
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
        {/* Scroll-up lazy-load sentinel. A fixed-height slot kept whenever older history remains so mounting
            the spinner doesn't shift the transcript; the spinner shows only while a page is loading. */}
        {hasMoreHistory ? (
          <div data-testid="chat-history-sentinel" className="flex h-8 shrink-0 items-center justify-center" aria-hidden={!loadingOlder}>
            {loadingOlder ? <Spinner size="md" label={t.brainChat.loadingOlder} /> : null}
          </div>
        ) : null}
        {/* Stable keys: history turns key by their store id, so a prepend never re-keys the existing turns;
            the live streaming tail (no id) keys by its offset within the live suffix, which is invariant
            under a prepend (older turns only ever go in front) — so a prepend mid-turn never remounts it. */}
        {turns.map((turn, i) => {
          const key = turn.id ?? `live:${i - firstLiveTurn}`;
          return (
            <Message
              key={key}
              tk={key}
              turn={turn}
              full={variant === 'full'}
              showRole={i === 0 || turns[i - 1].role !== turn.role}
              showThoughts={showThoughts}
            />
          );
        })}
        {/* Out-of-band extras (cards, processes, agents, questions). In the full page they get their own
            spacing group under the flush transcript; in the dock `contents` keeps them in the parent's
            gap flow exactly as before. `empty:hidden` drops the group when everything in it is null.
            The monospace type is set ONCE here and inherited by every extra, so the todo card and the
            agents chip end up the exact size the statusline and the tool rows use for the same variant
            instead of each hardcoding `text-tiny` and reading smaller than the column they sit in.
            `display:contents` keeps inheriting, it only removes the box.
            Background processes are deliberately NOT here: the telemetry panel is their single home, so
            a long-running command reports in one place instead of also crowding the composer. */}
        <div className={`font-mono ${variant === 'full' ? 'mt-4 flex flex-col gap-3 text-[0.6875rem] empty:hidden' : 'contents text-tiny'}`}>
        {transcriptExtras ? todoCards.map((card) => <CardBlock key={card.id} card={card} live={busy} />) : null}
        {/* Workflow view: a clickable link that opens the table of delegated agents (drill-in / back). The
            table itself stays mounted below whatever the rail does — `agentsOpen` lives in the provider, so
            the rail's own agent row opens THIS instance. Only the chip is redundant beside an open rail. */}
        {subagents.length > 0 && !railOwnsLiveWork && transcriptExtras ? (
          <button
            type="button"
            onClick={() => setAgentsOpen(true)}
            className="flex items-center gap-1.5 self-start leading-relaxed text-text-muted transition-colors hover:text-text"
          >
            <Users size={11} aria-hidden />
            {/* Never fall back to the transcript's total when nothing runs: that is what let a finished
                agent be announced as a running one. No runner left → the chip names the finished work. */}
            <span>{runningAgents > 0
              ? `${runningAgents} ${plural(t.agents.link, runningAgents)}`
              : `${subagents.length} ${plural(t.agents.linkDone, subagents.length)}`}</span>
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
        {statsOpen ? (
          <StatsModal onClose={() => setStatsOpen(false)} />
        ) : null}
        {reasoningOpen ? (
          <ReasoningModal onClose={() => setReasoningOpen(false)} />
        ) : null}
        {skillsOpen ? (
          <SkillsModal onClose={() => setSkillsOpen(false)} />
        ) : null}
        {tasksOpen ? (
          <TasksModal onClose={() => setTasksOpen(false)} />
        ) : null}
        {helpOpen ? (
          <HelpModal onClose={() => setHelpOpen(false)} />
        ) : null}
        {modelOpen ? (
          <ModelModal onClose={() => setModelOpen(false)} />
        ) : null}
        {todosOpen ? (
          <Modal title={t.chat.todos} onClose={() => setTodosOpen(false)} size="md" icon={ListChecks}>
            <ModalBody>
              {/* Outside the transcript there is no wrapper to inherit from, so the modal states the
                  same monospace type itself. */}
              <div className="flex flex-col gap-3 font-mono text-tiny">
                {todoCards.map((card) => <CardBlock key={card.id} card={card} live={busy} />)}
              </div>
            </ModalBody>
          </Modal>
        ) : null}
        {/* Plan mode's decision point: the model submitted a plan and the turn settled. The controller
            derives it from the DAEMON's answer, so it also appears for a plan submitted from the CLI and
            survives a reload — and it is a modal, like the CLI picker, because implementing is the only
            thing that leaves plan mode. */}
        {planDecision ? (
          <PlanDecisionModal
            plan={planDecision.plan}
            submitting={planSubmitting}
            onImplement={implementPlan}
            onDismiss={dismissPlan}
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
          dock keeps it in normal flow at the bottom of its own scroll box.

          `.chat-composer-dock` (chat.css) carries the bottom safe-area inset. Without it the composer's
          send button sits UNDER a phone's home indicator: the dock is pinned at `bottom: 0`, which is the
          edge of the viewport, not the edge of the usable screen. */}
      <div className={variant === 'full' ? 'chat-composer-dock sticky bottom-0 z-10 bg-bg' : ''}>
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
      {/* Statusline (the statusline plugin's toggles decide what shows; hidden when disabled). A leading
          chevron collapses the whole row in-chat — the quick alternative to the plugin's settings, mainly
          for a phone where the metrics crowd the composer. Collapsed leaves only the chevron to bring it
          back. */}
      {lineCfg && (lineCfg.showModel || lineCfg.showContext || lineCfg.showTokens || lineCfg.showSpeed || lineCfg.showCost) ? (
        // Exactly ONE line, phone included: a second row here pushes the composer down and eats the little
        // vertical room a phone has. Each statistic stays whole (`shrink-0 whitespace-nowrap`, needed
        // because a no-wrap FLEX row still lets each item's own text wrap) — but when the row runs out of
        // width it is the STATISTICS that give way, cheapest first, and the model name that keeps the room
        // they free. Which one drops at which width is the `[data-stat]` ladder in chat.css, driven by the
        // row's own container: the docked telemetry rail narrows it without the viewport changing.
        <div data-testid="chat-statusline" className={`chat-statusline flex min-w-0 items-center gap-x-2 overflow-hidden py-1 font-mono text-text-muted sm:gap-x-3 ${variant === 'full' ? 'chat-gutter text-[0.6875rem]' : 'px-3 text-tiny'}`}>
          <button
            type="button"
            onClick={() => setStatuslinePref(statuslineShown ? 'hidden' : 'shown')}
            aria-expanded={statuslineShown}
            aria-label={statuslineShown ? t.chat.hideStats : t.chat.showStats}
            title={statuslineShown ? t.chat.hideStats : t.chat.showStats}
            className="flex shrink-0 items-center rounded text-text-muted transition-colors hover:text-text"
          >
            <ChevronRight size={11} aria-hidden className={`opacity-60 transition-transform ${statuslineShown ? 'rotate-90' : ''}`} />
          </button>
          {statuslineShown ? (
            <>
              {lineCfg.showModel && (currentModel || active?.model) ? (() => {
                const model = currentModel || active?.model || '';
                const modelProvider = currentModel ? provider : (active?.provider ?? '');
                const label = brainModelQualifiedLabel({ provider: modelProvider, model });
                return <span data-stat="model" className="min-w-0 truncate" title={label}>{label}</span>;
              })() : null}
              {lineCfg.showContext && usage && usage.percent != null ? (
                <span data-stat="context" className="shrink-0 whitespace-nowrap">{t.brainChat.context} {Math.round(usage.percent)}% ({formatTokens(usage.tokens ?? 0)}/{formatTokens(usage.contextWindow)})</span>
              ) : null}
              {lineCfg.showTokens && usage ? <span data-stat="tokens" className="shrink-0 whitespace-nowrap">Σ {formatTokens(usage.totalTokens)} {t.sessionsPanel.tok}</span> : null}
              {/* Measured generation speed: absent until something has been timed, and hidden below
                  1 tok/s where the rounded figure would read as a stall rather than as too few samples. */}
              {lineCfg.showSpeed && typeof usage?.outputTps === 'number' && usage.outputTps >= 1 ? (
                <span data-stat="speed" className="shrink-0 whitespace-nowrap">{Math.round(usage.outputTps)} {t.brainChat.tokensPerSecond}</span>
              ) : null}
              {lineCfg.showCost && usage ? <span data-stat="cost" className="shrink-0 whitespace-nowrap">{formatCost(usage.cost, 2)}</span> : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* Staged attachments. */}
      {attachments.length > 0 ? (
        <div className={`flex flex-wrap gap-2 py-2 ${variant === 'full' ? 'chat-gutter' : 'px-3'}`}>
          {attachments.map((a, i) => (
            /* No thumbnail: the file is already on the daemon, not held in the browser, so there is
               nothing local to preview. The title names where it landed, which is what the user
               actually needs — the file stays in their project after the conversation. */
            <span key={i} title={a.relative} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated py-1 pl-1.5 pr-1 text-tiny text-text">
              <FileText size={13} className="text-text-muted" aria-hidden />
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
        <div className={variant === 'full' ? 'chat-gutter chat-composer-slot' : ''}>
          <div className={`flex items-center justify-between gap-2 bg-elevated/40 p-3 text-sm text-text-muted ${variant === 'full' ? 'rounded-xl border border-border' : ''}`}>
            <span className="flex min-w-0 items-center gap-2"><FileText size={14} className="shrink-0" aria-hidden /><span className="truncate">{t.brainChat.readOnly}</span></span>
            <button type="button" onClick={exitReadOnly} className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-text transition-colors hover:bg-elevated">{t.brainChat.readOnlyExit}</button>
          </div>
        </div>
      ) : (
      <div className={variant === 'full' ? 'chat-gutter chat-composer-slot' : ''}>
      {/* In the full page the whole composer is ONE quiet rounded field (attach + textarea + send inside
          it, Claude-style); the dock keeps its original three-control row. */}
      <form
        className={variant === 'full'
          ? 'chat-composer relative flex items-end gap-1 rounded-2xl border border-border bg-surface p-1.5 transition-colors focus-within:border-border-strong'
          : 'relative flex items-end gap-2 p-2'}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        {slashOpen && (
          <div data-testid="chat-slash-menu" className={`absolute bottom-full w-full max-w-md overflow-hidden rounded-lg border border-border bg-elevated shadow-lg ${variant === 'full' ? 'left-0 mb-2' : 'left-2 mb-1'}`}>
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
          data-testid="chat-composer"
          value={input}
          onChange={(e) => { setInput(e.target.value); setSlashIdx(0); }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (Math.min(i, slashItems.length - 1) + 1) % slashItems.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (Math.min(i, slashItems.length - 1) - 1 + slashItems.length) % slashItems.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); slashItems[slashSel]?.run(); return; }
              if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
            }
            // ↑ with empty input + queued message → recall into composer
            if (e.key === 'ArrowUp' && input === '' && queued.length > 0) {
              e.preventDefault();
              const last = queued[queued.length - 1];
              onQueueRemove(last.id);
              setInput(last.text);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          rows={1}
          placeholder={t.brainChat.placeholder}
          // How tall the composer may grow is a share of the SCREEN, not a fixed desktop figure. The flat
          // 10rem this used to carry is a comfortable third of a desktop composer and most of a landscape
          // phone, which is how the dock came to take half the reading height at 740x360. dvh, never vh:
          // a collapsing mobile toolbar makes vh taller than the screen really is.
          className={`max-h-[min(10rem,22dvh)] flex-1 resize-none text-sm text-text placeholder:text-text-muted ${
            variant === 'full'
              ? 'bg-transparent px-2 py-2 focus:outline-none'
              : 'rounded-lg border border-border bg-bg px-3 py-2 focus:border-accent'
          }`}
        />
        {busy ? (
          <button
            type="button"
            data-testid="chat-stop"
            onClick={abort}
            aria-label={t.brainChat.stop}
            className={`flex h-9 w-9 shrink-0 items-center justify-center transition-colors ${
              variant === 'full'
                ? 'rounded-xl bg-accent text-text hover:bg-accent-hot'
                : 'rounded-lg border border-accent bg-accent/15 text-accent hover:bg-accent/25'
            }`}
          >
            <Square size={14} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            data-testid="chat-send"
            disabled={!input.trim() && attachments.length === 0}
            aria-label={t.brainChat.send}
            className={`flex h-9 w-9 shrink-0 items-center justify-center transition-colors disabled:opacity-40 ${
              variant === 'full'
                ? 'rounded-xl bg-accent text-text hover:bg-accent-hot'
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
      {renameOpen ? (
        <RenameDialog
          current={active?.title ?? ''}
          onClose={closeRename}
          onSubmit={(title) => void renameSession(title)}
        />
      ) : null}
    </div>
  );
}
