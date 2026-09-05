'use client';
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Send, Square, Plus, ChevronDown, Paperclip, X, FileText, Download, Users, ChevronRight, Brain, Activity, Pencil, MoreHorizontal, ListChecks, Clock3, ImageOff, ExternalLink, Compass, Hammer, Workflow, type LucideIcon } from 'lucide-react';
import { toolGlyph } from '../../lib/toolGlyph';
import { usePersistentState } from '../../lib/usePersistentState';
import { interpolate, plural, useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import type { LocaleDict } from '../../lib/i18n/types';
import { useMobileViewport } from '../../lib/useMobile';
import { useToast } from '../../components/ui/Toast';
import type { BrainCard, BrainInlineArtifact, BrainMessageFile, BrainMessageImage, BrainModelOption, BrainWorkMode, SlashCommandDef } from '../../lib/types';
import { groupToolItems, type ChatTurn, type SessionEventItem, type ToolItem } from '../../lib/transcript';
import { MorePill } from '../../components/ui/MorePill';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button, buttonClassName } from '../../components/ui/Button';
import { Progress } from '../../components/ui/shadcn/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../../components/ui/shadcn/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/shadcn/popover';
import { Input } from '../../components/ui/Input';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { AskQuestionCard } from './AskQuestionCard';
import { AgentsTable } from './AgentsTable';
import { TodoRow, type TodoRowIds } from './TodoRow';
import { StatsModal } from './StatsModal';
import { ReasoningModal } from './ReasoningModal';
import { SkillsModal } from './SkillsModal';
import { TasksModal } from './TasksModal';
import { pluginPickerComponent } from './pluginPickers';
import { HelpModal } from './HelpModal';
import { ModelModal } from './ModelModal';
import { PlanDecisionModal } from './PlanDecisionModal';
import { GoalStatusInline } from './GoalStatus';
import { ChatHistoryRail } from './ChatHistoryRail';
import { ModelPicker } from './ModelPicker';
import { ProjectPicker } from './ProjectPicker';
import { useBrainChat, useBrainChatInput } from './BrainChatProvider';
import { formatBytes, formatTokens, formatCost, formatDuration, localDateTime } from '../../lib/format';
import { Spinner } from '../../components/ui/states';
import { brainModelLabel, brainModelQualifiedLabel } from '../../lib/modelProvider';
import { isBackgroundProcessCardId } from '../../lib/processScope';
import { PageTopBarPortal } from '../../lib/pageHeader';
import { uiZoom } from '../../lib/uiZoom';
import { parseSlashInvocation } from '../../lib/slashCommands';
import {
  DEFAULT_COMPOSE_MARKER_MS,
  DEFAULT_LONG_TOOL_COMPOSE_MARKER_MS,
  LONG_COMPOSE_TOOLS,
  TODO_CARD_ID,
  TODO_PREVIEW_ITEMS,
  composingLabel,
  todoPreviewItems,
  type ComposeLocale,
  type TodoPreviewItem,
} from '../../lib/chatPresentation';
import { cardTasks, cardTasksAddressable, type RailTask } from '../../lib/railTasks';
import { useSessionTasks } from '../../lib/queries';
import { useUpdateSessionTask } from '../../lib/mutations';
import type { PluginChatPendingInput } from 'elowen-plugin-ui-kit';
import { InlineArtifact } from './InlineArtifact';

const STATUSLINE_VALUES = ['shown', 'hidden'] as const;

/** Sanitized-markdown block for one assistant text segment (marked + DOMPurify, no bubble). */
function TextSegment({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={`chat-markdown text-sm leading-relaxed text-foreground ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
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
    <div className="my-1 overflow-hidden rounded-md bg-muted/40 py-1">
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
            : sign === '-' ? 'border-destructive/50 bg-destructive/10 text-destructive'
            : 'border-transparent text-muted-foreground';
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
      : 'bg-muted/40 text-muted-foreground';
  return (
    <div data-testid="chat-tool-output" className={`my-1 overflow-hidden whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 ${tone}`}>
      {output.command ? <div className="text-foreground">$ {output.command}</div> : null}
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

/** Fold state, preview window and the elapsed clock — everything a card rendering needs that is NOT about
 *  what a row looks like, in one place so the read-only and the interactive card cannot drift apart on how
 *  a card folds or how fast it ticks.
 *
 *  The clock is a local interval rather than the shared `useNow` heartbeat because it is allowed to stop:
 *  it runs only while the turn is live AND some row is actually running, so a settled transcript full of
 *  finished cards holds no timer at all. */
function useCardShell<T extends TodoPreviewItem & { startedAt?: number }>(items: readonly T[], live: boolean) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ticking = live && items.some((item) => item.status === 'in_progress' && Number.isFinite(item.startedAt));
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [ticking]);
  const previewable = items.length > TODO_PREVIEW_ITEMS;
  const shown = collapsed ? [] : previewable && !expanded ? todoPreviewItems(items, TODO_PREVIEW_ITEMS) : [...items];
  return { collapsed, setCollapsed, expanded, setExpanded, now, previewable, shown };
}

/** The chevron + title + done/total head both card renderings share, and the fold's only trigger.
 *
 *  Anything else the head carries rides BESIDE the button rather than inside it: a `<button>` may hold
 *  phrasing content only, so the todo card's meter (a `progressbar`) and its way into the task list (a
 *  second button) cannot be nested in the one that folds the card. */
function CardHead({ title, done, total, collapsed, onToggle, trailing }: {
  title: string;
  done: number;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight size={11} aria-hidden className={`shrink-0 opacity-60 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        <span className="truncate">{title}</span>
        {total > 0 ? <span className="shrink-0 tabular-nums opacity-70">{done}/{total}</span> : null}
      </button>
      {trailing}
    </div>
  );
}

/** A card nobody can act on: another plugin's checklist, or a todo card emitted before task ids existed.
 *  It is the rendering the transcript has always had — a glyph, the glued `text` the emitter composed, and
 *  a struck-through line once a row is done.
 *
 *  Read-only is a CORRECTNESS rule, not a missing feature. Card items are a generic mechanism, so a plugin
 *  may emit rows with ids of its own; those ids are its handles, and a tick box built from one would PATCH
 *  the todo API with something that means nothing there. */
function StaticCard({ card, live }: { card: BrainCard; live: boolean }) {
  const { t } = useTranslation();
  const items = card.items ?? [];
  const { collapsed, setCollapsed, expanded, setExpanded, now, previewable, shown } = useCardShell(items, live);
  const done = items.filter((i) => i.status === 'completed').length;
  if (items.length > 0 && done === items.length) return null;
  return (
    <div data-testid="chat-card" className="flex flex-col leading-relaxed">
      {(card.title || items.length > 0) ? (
        <CardHead
          title={card.title ?? t.brainChat.cardFallback}
          done={done}
          total={items.length}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
        />
      ) : null}
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {shown.map((titem, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={`shrink-0 ${titem.status === 'completed' ? 'text-success' : titem.status === 'in_progress' ? 'text-primary' : 'text-muted-foreground'}`}>
                {titem.status === 'completed' ? '✔' : titem.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className={titem.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}>
                {titem.text}
                {titem.status === 'in_progress' && Number.isFinite(titem.startedAt) ? (
                  <span data-testid="chat-card-elapsed" className="ml-1 tabular-nums text-muted-foreground opacity-70">· {formatDuration(now - titem.startedAt!)}</span>
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
      {!collapsed && card.body ? <div className="whitespace-pre-wrap break-words text-muted-foreground">{card.body}</div> : null}
    </div>
  );
}

/** The card's row test ids: the shared `TodoRow` stamps these so the card's tests keep addressing it by
 *  the names it has always had. */
const CARD_ROW_IDS: TodoRowIds = { row: 'chat-card-row', running: 'chat-card-running', elapsed: 'chat-card-elapsed', blocked: 'chat-card-blocked' };

/** The conversation's checklist, where it has always been — the last thing above the composer — and now
 *  something the reader can work rather than only read.
 *
 *  This is the ONLY checklist on screen whenever the telemetry rail is not carrying its Tasks section: a
 *  collapsed rail on a desktop, and every phone, which has no dock at all. So it holds the same three
 *  moves the rail does — tick, change status, open the full list — in a shape that survives a 390px
 *  screen: no hover reveals, a real menu behind the label, and the meter and the fold in the head rather
 *  than a second row of chrome.
 *
 *  A mutation lands here through the ordinary PATCH and then rebuilds the card from the response
 *  (`syncSessionTasks`), because the todo plugin's HTTP routes answer the caller without re-emitting the
 *  panel. Nothing is written into the card before the daemon agrees, so a refused patch leaves the row
 *  exactly as it was and the failure is reported rather than swallowed. */
function TodoCard({ card, rows, live }: { card: BrainCard; rows: readonly RailTask[]; live: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { activeSessionId, setTasksOpen, syncSessionTasks } = useBrainChat();
  const updateTask = useUpdateSessionTask();
  const { collapsed, setCollapsed, expanded, setExpanded, now, previewable, shown } = useCardShell(rows, live);
  const done = rows.filter((row) => row.status === 'completed').length;
  const openTasks = (): void => setTasksOpen(true);
  const setStatus = (row: RailTask, status: RailTask['status']): void => {
    if (!activeSessionId || !row.id || status === row.status) return;
    updateTask.mutate(
      { sessionId: activeSessionId, taskId: row.id, status },
      { onSuccess: (result) => syncSessionTasks(result.tasks), onError: (error: Error) => toast(error.message, 'error') },
    );
  };
  if (done === rows.length) return null;
  return (
    // `self-start`: the card is as wide as its longest row, not the column, so the head's meter and the
    // rows' targets sit next to the text instead of at the far edge of a wide screen.
    <div data-testid="chat-card" className="flex max-w-[min(100%,28rem)] flex-col self-start leading-tight">
      {/* The plugin titles the card in English; the reader gets the same word the rail's Tasks section
          uses in their own language. */}
      <CardHead
        title={t.telemetry.tasks}
        done={done}
        total={rows.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        trailing={
          <>
            <Progress className="h-0.5 w-10 shrink-0" value={(done / rows.length) * 100} aria-label={t.telemetry.tasks} />
            {/* Renaming, deleting and the bulk clears live in the modal — the card stays a checklist. */}
            <Button
              variant="ghost"
              size="icon"
              data-testid="chat-card-open-tasks"
              onClick={openTasks}
              aria-label={t.telemetry.tasksOpen}
              title={t.telemetry.tasksOpen}
              className="size-6 shrink-0 rounded"
            >
              <ListChecks size={12} aria-hidden />
            </Button>
          </>
        }
      />
      {shown.length > 0 ? (
        <ul className="flex flex-col">
          {shown.map((row) => (
            <TodoRow
              key={row.id}
              row={row}
              now={now}
              onStatus={setStatus}
              onOpen={openTasks}
              ids={CARD_ROW_IDS}
            />
          ))}
        </ul>
      ) : null}
      {!collapsed && previewable ? (
        <div className="mt-1">
          <MorePill expanded={expanded} hidden={rows.length - TODO_PREVIEW_ITEMS} onToggle={() => setExpanded((v) => !v)} />
        </div>
      ) : null}
      {!collapsed && card.body ? <div className="whitespace-pre-wrap break-words text-muted-foreground">{card.body}</div> : null}
    </div>
  );
}

/** A display card (ctx.emitCard) — the web mirror of the CLI/Discord panel: a title row with a done/total
 *  count that collapses the card, a checklist previewed to its first items, and an optional freeform body.
 *  A checklist with everything ticked leaves the transcript entirely — the CLI panel drops it the same
 *  way, because a finished list has nothing left to track.
 *
 *  Which of the two renderings a card gets is decided by the SAME pair the rail's Tasks section uses, and
 *  not by a second opinion of its own: `cardTasks` answers for the todo card and nothing else (it matches
 *  on `TODO_CARD_ID`), and `cardTasksAddressable` refuses a half-addressable list, so a card older than
 *  task ids falls back to the read-only rendering instead of offering controls that work on some rows. */
export function CardBlock({ card, live }: { card: BrainCard; live: boolean }) {
  const rows = useMemo(() => cardTasks([card]), [card]);
  return cardTasksAddressable(rows)
    ? <TodoCard card={card} rows={rows} live={live} />
    : <StaticCard card={card} live={live} />;
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
            <span className="shrink-0 text-muted-foreground">{tool.name}</span>
            {tool.detail ? <span className="truncate opacity-60">{tool.detail}</span> : null}
            {group.count > 1 ? <span className="shrink-0 tabular-nums opacity-50">×{group.count}</span> : null}
          </>
        );
        if (!rich) {
          return <div key={i} data-testid="chat-tool-pill" data-tool-id={tool.id} className="flex items-center gap-1.5 py-0.5 text-muted-foreground">{head}</div>;
        }
        return (
          <details key={i} data-testid="chat-tool-pill" data-tool-id={tool.id} className="chat-tool">
            <summary className="flex cursor-pointer items-center gap-1.5 rounded py-0.5 text-muted-foreground transition-colors hover:text-foreground">
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
    <div data-testid="chat-plan" className="my-1 overflow-hidden rounded-md border border-border bg-muted">
      <div className="border-b border-border px-2.5 py-1 text-tiny uppercase tracking-wide text-muted-foreground">
        {t.brainChat.proposedPlan}
      </div>
      <div className="whitespace-pre-wrap break-words px-2.5 py-1.5 text-foreground">{plan}</div>
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
        className={`flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground ${full ? 'text-xs' : 'text-tiny'}`}
      >
        <ChevronRight size={11} aria-hidden className={`shrink-0 opacity-40 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{t.brainChat.reasoningLabel}</span>
        <span className="tabular-nums opacity-60">{formatDuration(elapsed)}</span>
      </button>
      {open ? <p className={`whitespace-pre-wrap break-words border-l-2 border-border pl-2 italic text-muted-foreground ${full ? 'text-xs' : 'text-tiny'}`}>{text}</p> : null}
    </div>
  );
}

/** Live rolling tail of a running Bash (the `tool_progress` event): the last lines of its output
 *  as it streams, in a muted terminal block. Cleared once the final `output`/`diff` lands, so it never
 *  doubles the final dump. */
function ProgressBlock({ text }: { text: string }) {
  return (
    <div className="my-1 overflow-hidden rounded-md bg-muted/40 px-2.5 py-1.5 text-muted-foreground">
      {text.split('\n').slice(-PROGRESS_TAIL_ROWS).map((l, i) => <div key={i} className="whitespace-pre-wrap break-words">{l || ' '}</div>)}
    </div>
  );
}

/** A context-compaction boundary: a subtle labelled divider standing in for the summarized-away history. */
function ContextDivider({ full }: { full?: boolean }) {
  const { t } = useTranslation();
  return (
    <div data-testid="chat-turn" data-role="divider" className={`flex items-center gap-2 text-tiny text-muted-foreground ${full ? 'my-5' : 'my-1'}`} role="separator">
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
    <div data-tk={tk} data-testid="chat-turn" data-role="event" className="flex flex-col gap-0.5 py-1 text-tiny text-muted-foreground">
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
 *  signed link is involved. Clicking opens the picture in the app's own dialog. */
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
  const [open, setOpen] = useState(false);

  if (failed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
        <ImageOff size={14} className="shrink-0" aria-hidden />
        {t.brainChat.attachmentGone}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t.brainChat.attachmentOpen}
        aria-label={t.brainChat.attachmentOpen}
        // The width cap sits on the FRAME, not the picture. A percentage max-width on the <img> is ignored
        // while the flex item measures its content, so a wide picture capped only by height left the
        // border hanging around empty space — the button was sized for the uncapped width.
        className="block max-w-[min(16rem,100%)] overflow-hidden rounded-lg border border-border transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <img
          src={`/api${image.url}`}
          alt={t.brainChat.attachmentAlt}
          onError={() => setFailed(true)}
          className="block max-h-48 max-w-full object-contain"
        />
      </button>
      {open ? <ImageLightbox image={image} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The full-size view of any picture in the conversation — a user's attachment, one the agent shared, one
 *  it generated, one it read. It is the shared {@link Modal}, so the focus trap, Escape, the overlay stack
 *  and the return of focus to the thumbnail all come from the one implementation the rest of the app uses,
 *  and the page behind it never scrolls.
 *
 *  The picture itself is `object-contain` inside the dialog's own frame, so a panorama and a tall
 *  screenshot both fit whole on a phone and on a desktop without the dialog growing past the viewport.
 *  Opening the raw file stays available as a named action in the header rather than as the click on the
 *  image: that request is the same authenticated proxy fetch it always was, and it leaves the app. */
function ImageLightbox({ image, onClose }: { image: BrainMessageImage; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      title={t.brainChat.imageViewerTitle}
      onClose={onClose}
      size="lg"
      presentation="center"
      intent="inspect"
      headerActions={(
        <a
          href={`/api${image.url}`}
          target="_blank"
          rel="noreferrer"
          className={buttonClassName('outline', 'sm')}
        >
          <ExternalLink size={14} aria-hidden />
          {t.brainChat.imageOpenInTab}
        </a>
      )}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <img
          src={`/api${image.url}`}
          alt={t.brainChat.attachmentAlt}
          data-testid="image-lightbox"
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </Modal>
  );
}

/** An image the agent shared on purpose (`ShareImage`). It is the same picture-in-the-conversation the
 *  user's own attachments are — same proxy path, same click-through to full size — so it reuses
 *  {@link Attachments} rather than growing a second thumbnail. Only the caption underneath is its own. */
function SharedImage({ image, caption, full }: { image: BrainMessageImage; caption?: string; full?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <Attachments images={[image]} full={full} />
      {caption ? <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{caption}</div> : null}
    </div>
  );
}

/** A file the agent handed over via ShareFile. The filename and size explain what will be fetched, while the
 *  shared button styling makes the action unmistakable without inventing a one-off control. */
function SharedFile({ file, caption, full }: { file: BrainMessageFile; caption?: string; full?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/50 p-3 ${full ? 'my-1.5' : ''}`} data-testid="shared-file">
      <div className="flex min-w-0 items-center gap-2.5">
        <FileText size={20} className="shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground" title={file.name}>{file.name}</div>
          <div className="text-xs text-muted-foreground">{formatBytes(file.size)}</div>
        </div>
        <a
          href={`/api${file.url}`}
          download={file.name}
          className={buttonClassName('default', 'sm', 'shrink-0')}
          aria-label={`${t.brainChat.fileDownload}: ${file.name}`}
        >
          <Download size={14} aria-hidden />
          {t.brainChat.fileDownload}
        </a>
      </div>
      {caption ? <div className="text-xs leading-relaxed text-muted-foreground">{caption}</div> : null}
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
function MessageMeta({ turn, models }: {
  turn: Extract<ChatTurn, { role: 'you' | 'elowen' }>;
  models?: readonly BrainModelOption[];
}) {
  const { locale, t } = useTranslation();
  const settled = turn.role === 'elowen' ? turn.durationMs != null : Boolean(turn.createdAt);
  if (!settled) return null;
  const modelLabel = turn.role === 'elowen' && turn.model ? brainModelLabel(turn.model, models) : '';
  return (
    <div data-testid="chat-turn-meta" data-role={turn.role === 'you' ? 'user' : 'assistant'} className={`chat-turn-meta ${turn.role === 'you' ? 'mt-1.5' : 'mt-1'} flex items-center gap-2 text-caption leading-none text-muted-foreground`}>
      {turn.createdAt ? <time dateTime={turn.createdAt}>{localDateTime(turn.createdAt, locale, false)}</time> : null}
      {turn.role === 'elowen' && turn.model ? (
        <span data-testid="chat-turn-model" className="inline-flex min-w-0 items-center gap-1" title={turn.model}>
          <ModelIcon name={modelLabel} size={10} />
          <span className="max-w-48 truncate">{modelLabel}</span>
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
    <div data-testid="chat-tool-authoring" role="status" aria-live="polite" className="flex items-center gap-1.5 py-0.5 pl-4 font-mono text-muted-foreground">
      <Spinner size="xs" tone="text-warning" />
      <span className="truncate italic opacity-80">{label}</span>
    </div>
  );
}

type MessageProps = { turn: ChatTurn; artifacts: BrainInlineArtifact[]; narration?: string; pendingInput?: PluginChatPendingInput | null; models?: readonly BrainModelOption[]; full?: boolean; showRole?: boolean; showThoughts: boolean; tk?: string };

const NO_ARTIFACTS: BrainInlineArtifact[] = [];

/** Only artifact-bearing turns consume live narration and pending-input changes. Keep those updates
 *  from invalidating every settled message, while still delivering them to every mounted artifact. */
export function Message({ artifacts, narration, pendingInput, ...props }: MessageProps) {
  const { turn } = props;
  const attached = useMemo(() => artifacts.filter((artifact) => turn.role === 'elowen'
    && turn.segments.some((segment) => segment.kind === 'tools'
      && segment.items.some((tool) => tool.id === artifact.toolCallId))), [turn, artifacts]);
  return <MessageBody {...props} artifacts={attached.length ? attached : NO_ARTIFACTS}
    narration={attached.length ? narration : undefined}
    pendingInput={attached.length ? pendingInput : undefined} />;
}

/** Stored turns retain their identity across stream updates. Keep their mounted, interactive history
 *  out of the live render path rather than hiding or removing it. */
const MessageBody = memo(function MessageBody({ turn, artifacts, narration, pendingInput, models, full, showRole, showThoughts, tk }: MessageProps) {
  const { t, locale } = useTranslation();
  const { agentName } = useBrand();
  if (turn.role === 'divider') return <ContextDivider full={full} />;
  if (turn.role === 'event') return <SessionEvents events={turn.events} tk={tk} />;

  const you = turn.role === 'you';
  const roleAttr = you ? 'you' : 'assistant';
  const body = turn.role === 'you'
    ? <div data-testid="chat-user-bubble" className="chat-user-message">
        {turn.text.trim() ? <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground ${full ? '' : 'my-1.5'}`}>{turn.text}</div> : null}
        {turn.images?.length ? <Attachments images={turn.images} full={full} /> : null}
        <MessageMeta turn={turn} models={models} />
      </div>
    : <>{turn.segments.map((seg, i) => (seg.kind === 'text'
        ? <TextSegment key={i} text={seg.text} className={full ? 'my-1.5' : ''} />
        : seg.kind === 'reasoning'
        ? (showThoughts ? <ReasoningBlock key={i} text={seg.text} full={full} live={turn.streaming && i === turn.segments.length - 1} /> : null)
        : seg.kind === 'image'
        ? <SharedImage key={i} image={seg.image} caption={seg.caption} full={full} />
        : seg.kind === 'file'
        ? <SharedFile key={i} file={seg.file} caption={seg.caption} full={full} />
        : <Fragment key={i}>
            <ToolPills tools={seg.items} full={full} live={turn.streaming && i === turn.segments.length - 1} />
            {artifacts
              .filter((artifact) => seg.items.some((tool) => tool.id === artifact.toolCallId))
              .map((artifact) => <InlineArtifact key={`${artifact.plugin}:${artifact.id}`} artifact={artifact} narration={narration} pendingInput={pendingInput} />)}
          </Fragment>))}
        {turn.composing ? <ToolAuthoringHint turn={turn} locale={locale as ComposeLocale} /> : null}
      </>;

  if (full) {
    return (
      <div data-tk={tk} data-testid="chat-turn" data-role={roleAttr} className={`chat-turn chat-turn--${roleAttr} grid grid-cols-[16px_1fr] gap-x-3 ${showRole ? 'mt-6 first:mt-0' : ''}`}>
        {showRole ? (
          <span aria-hidden className={`chat-turn__marker mt-1.5 h-2 w-2 rounded-full ${you ? 'bg-primary ring-4 ring-primary/15' : 'bg-muted-foreground'}`} />
        ) : <span aria-hidden className="chat-turn__marker" />}
        <div className="chat-turn__column min-w-0">
          {showRole ? <div className={`chat-turn__role mb-0.5 text-xs font-semibold ${you ? 'text-primary' : 'text-muted-foreground'}`}>{you ? t.chat.roleYou : interpolate(t.chat.roleElowen, { agentName })}</div> : null}
          <div data-testid={you ? undefined : 'chat-assistant-body'} className="chat-turn__body flex min-w-0 flex-col">{body}</div>
          {you ? null : <MessageMeta turn={turn} models={models} />}
        </div>
      </div>
    );
  }

  if (you) {
    return (
      <div data-tk={tk} data-testid="chat-turn" data-role={roleAttr} className="ml-8 flex max-w-full flex-col items-end self-end">
        <div data-testid="chat-user-bubble" className="whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
          {turn.role === 'you' ? turn.text : null}
          {turn.role === 'you' && turn.images?.length ? <Attachments images={turn.images} /> : null}
          <MessageMeta turn={turn} models={models} />
        </div>
      </div>
    );
  }
  return <div data-tk={tk} data-testid="chat-turn" data-role={roleAttr} className="mr-4 flex flex-col gap-1.5 self-start"><div data-testid="chat-assistant-body" className="flex flex-col gap-1.5">{body}</div><MessageMeta turn={turn} models={models} /></div>;
});

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
      className={`flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
        full ? 'h-8 w-8' : 'h-7 w-7'
      }`}
    >
      <Brain size={full ? 18 : 16} aria-hidden />
    </button>
  );
}

/** Which work mode the next send is stamped with — shown and changed in ONE control that sits in the
 *  composer row immediately left of the send/stop button, on every surface (full page, dock, phone).
 *
 *  The trigger is a small ghost button showing the CURRENT mode's glyph and label, so the mode is always
 *  visible (it changes what the agent may do and must never be a hidden switch) and always one click from
 *  being changed — the old read-only pill made you hunt for the slash command instead. Plan and workflow
 *  keep the pill's accent tint so a non-default mode still reads as "on"; build stays quiet.
 *
 *  Opening is the shadcn DropdownMenu (click/keyboard only — a hover-open menu has no place above a live
 *  conversation) over a `RadioGroup` of the daemon catalog's `kind:'mode'` commands, each row carrying the
 *  command's one-line description as muted secondary text. Selecting runs the SAME `runSlash` path the
 *  slash menu and `/help` use, so the toast, the daemon command and every side effect stay identical —
 *  this is a second door onto the composer, never a second implementation.
 *
 *  Radix owns the keyboard grammar (Enter/Space open, arrows move, Escape closes and refocuses the
 *  trigger); the trigger is in the natural tab order right before send. On a 390px phone the label
 *  collapses to the glyph — `aria-label` names the control regardless. */
const WORK_MODE_GLYPHS: Record<BrainWorkMode, LucideIcon> = { build: Hammer, plan: Compass, workflow: Workflow };

function WorkModeSwitch({ variant }: { variant: 'full' | 'compact' }) {
  const { t } = useTranslation();
  const { commands, runSlash, workMode } = useBrainChat();
  // The catalog is surface-filtered, so a mode the daemon withheld gets no row; the slash name IS the
  // mode value (`BrainChatProvider.WORK_MODES`), which is what lets a name pick a glyph without a cast
  // beyond the catalog's own string typing.
  const modeCommands = commands
    .filter((cmd): cmd is SlashCommandDef & { name: BrainWorkMode } => cmd.kind === 'mode' && cmd.name in WORK_MODE_GLYPHS)
    .map((cmd) => ({ command: cmd, icon: WORK_MODE_GLYPHS[cmd.name], label: t.brainChat.workMode[cmd.name] }));
  const run = (name: string): void => {
    const command = modeCommands.find((m) => m.command.name === name)?.command;
    if (command) runSlash(command);
  };
  const Icon = WORK_MODE_GLYPHS[workMode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="chat-work-mode-switch"
          aria-label={t.brainChat.workModeMenu}
          title={`${t.brainChat.workModeLabel}: ${t.brainChat.workMode[workMode]}`}
          // A phone gets the glyph alone, square, so the composer keeps its width for the text; the
          // label joins it from the app's phone breakpoint up (PHONE_MAX_WIDTH = 767 → `md:`).
          className={`flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 px-0 text-xs font-medium transition-colors md:w-auto md:px-2 ${
            variant === 'full' ? 'rounded-xl' : 'rounded-lg'
          } ${
            workMode === 'build'
              ? 'border border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
          }`}
        >
          <Icon size={15} aria-hidden />
          <span className="hidden md:inline">{t.brainChat.workMode[workMode]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-56" data-testid="chat-work-mode-menu">
        <DropdownMenuRadioGroup value={workMode} onValueChange={run}>
          {modeCommands.map(({ command, icon: RowIcon, label }) => (
            <DropdownMenuRadioItem key={command.name} value={command.name} data-testid={`chat-work-mode-${command.name}`}>
              <RowIcon size={14} aria-hidden className="mt-0.5 shrink-0" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">{label}</span>
                <span className="truncate text-xs text-muted-foreground">{t.brainChat.commandHints[command.name]}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phone-only overflow for the conversation bar: on a narrow screen the bar can't hold the model picker
 *  inline without cramming, so it folds behind one ⋯ button. The work-mode indicator deliberately does NOT
 *  live here any more — the composer's WorkModeSwitch shows (and changes) the mode on every surface, so a
 *  second, read-only mention would be noise. Phone actions lead the shared collision-aware popover;
 *  pickers follow them. Narrow desktops retain the picker fallback without duplicating inline actions. */
function BarOverflowMenu({ folded, onOpenTasks, onNewChat }: {
  /** New chat folds here on phones; reasoning and telemetry remain directly on the bar. */
  folded: boolean;
  onOpenTasks: () => void;
  onNewChat: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actionPicked = useRef(false);
  const rowClass = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent';
  /** A row's action opens a modal or drawer whose focus scope remembers what was focused when it opened.
   *  The row itself is gone with the menu in that same commit, so focus is handed to the ⋯ trigger FIRST —
   *  that is where the overlay returns it on close, and a control that survives is the only one it can. */
  const pick = (action: () => void) => () => {
    actionPicked.current = true;
    triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    action();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t.chat.moreOptions}
        title={t.chat.moreOptions}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      </PopoverTrigger>
      <PopoverContent data-chat-popover align="end" aria-label={t.chat.moreOptions}
        className="flex w-60 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] flex-col gap-0.5 overflow-y-auto p-1.5"
        onCloseAutoFocus={(event) => {
          // A picked action already handed focus to its modal. Do not steal it back on unmount.
          if (actionPicked.current) event.preventDefault();
          actionPicked.current = false;
        }}>
          {/* Frequently used phone actions precede the wider composite pickers. */}
          {folded ? (
            <button type="button" onClick={pick(onNewChat)} className={rowClass}>
              <Plus size={16} className="text-muted-foreground" aria-hidden />
              <span>{t.brainChat.newChat}</span>
            </button>
          ) : null}
          {/* The mobile entry opens the same task manager as `/tasks`; there is one modal and one data path. */}
          <button type="button" onClick={pick(onOpenTasks)} className={rowClass}>
            <ListChecks size={16} className="text-muted-foreground" aria-hidden />
            <span>{t.chat.todos}</span>
          </button>
          <div className="px-1 pt-1"><ModelPicker variant="full" /></div>
          <div className="px-1 pb-1"><ProjectPicker variant="full" /></div>
      </PopoverContent>
    </Popover>
  );
}

/** The `/rename` dialog: the conversation's title prefilled, committed with Enter or the save button. The
 *  web twin of the CLI's rename prompt — the history rail renames inline, this renames the OPEN chat. */
function RenameDialog({ current, onClose, onSubmit }: { current: string; onClose: () => void; onSubmit: (title: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(current);
  const [status, setStatus] = useState<import('../../lib/useAutoSaveStatus').SaveStatus>('idle');
  const submit = async () => {
    const next = title.trim();
    if (!next || status === 'saving') return;
    setStatus('saving');
    try {
      await onSubmit(next);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };
  return (
    <Modal title={t.brainChat.renameTitle} onClose={onClose} closeDisabled={status === 'saving'} size="sm" icon={Pencil}>
      <ModalBody>
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          aria-label={t.chat.renamePlaceholder}
          placeholder={t.chat.renamePlaceholder}
        />
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={status} onRetry={() => void submit()} />}>
        <Button variant="ghost" onClick={onClose} disabled={status === 'saving'}>{t.common.cancel}</Button>
        <Button variant="accent" disabled={!title.trim() || status === 'saving'} onClick={() => void submit()}>{t.common.save}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** How close to the bottom still counts as sitting ON the newest turn. */
const BOTTOM_GAP = 80;
/** How close to the top asks for the next older page. */
const OLDER_TRIGGER = 120;
/** Keyboard inputs that can move the transcript. When already reading history, downward keys count too
 *  so reaching the bottom can re-enable following; while pinned, only upward keys may release it. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** Keep a short causal window between an input gesture and the browser's resulting scroll event. */
const USER_SCROLL_WINDOW_MS = 350;
/** The gap a docked plugin card keeps above the composer. It mirrors the `.75rem` term in the browser
 *  plugin's own `bottom: calc(...)`: the plugin decides where its card sits, so clearance measured against
 *  that card has to be written from the same offset. */
const DOCK_CARD_GAP_REM = 0.75;
/** One rem in real pixels. The card's offset is authored in rem and the app rescales the root font size
 *  (`--ui-scale`), so a hardcoded 12 would drift away from the card at every zoom except 100%. */
const remPx = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
/** Where the transcript's content actually ENDS, as a rect.
 *
 *  Not plain `lastElementChild`: the transcript's final child is the out-of-band extras group, and
 *  `empty:hidden` drops it to `display: none` whenever there are no cards, agents or pending question. A
 *  display-none element reports an all-zero rect, which would read as "the conversation ends at the top of
 *  the page", so walk back to the last child that still has a box. Nor the transcript's own rect: it is
 *  `flex-1`, so under a short conversation it is stretched well past where its content stops. */
const lastContentRect = (transcript: HTMLElement): DOMRect | null => {
  for (let node = transcript.lastElementChild; node; node = node.previousElementSibling) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return rect;
  }
  return null;
};

/** The docked plugin card, found by GEOMETRY rather than by name.
 *
 *  The contract this relies on: a docked live view is an absolutely positioned element inside one of the
 *  inline-artifact hosts the core itself renders (`data-artifact-id`, see InlineArtifact), and it is the
 *  element whose height the plugin published in `--chat-dock-height`. Matching that height is what
 *  identifies it, so this never has to name `.browser-artifact` — the core does not depend on any
 *  plugin's class, and a second plugin docking a card the same way works with no change here.
 *
 *  Why not `:scope > .browser-artifact`: the card is NOT a child of the surface. It is rendered deep in
 *  the transcript, inside a turn, and only its `position: absolute` lifts it out to the surface, which is
 *  its containing block. A child selector matches nothing at all. */
const dockedCardRect = (root: HTMLElement, publishedHeight: number): DOMRect | null => {
  for (const host of root.querySelectorAll<HTMLElement>('[data-artifact-id]')) {
    for (const node of [host, ...host.querySelectorAll<HTMLElement>('*')]) {
      if (getComputedStyle(node).position !== 'absolute') continue;
      const rect = node.getBoundingClientRect();
      // The plugin rounds the height up when it publishes, hence the tolerance rather than equality.
      if (Math.abs(rect.height - publishedHeight) <= 2) return rect;
    }
  }
  return null;
};

/** The block the wrap spacer rides on: the last prose block of the last turn.
 *
 *  It has to be prose specifically. A float only makes the LINE BOXES beside it shorter, and the turn's
 *  own wrapper is a grid while its body is a flex column — a float in either is ignored by the children,
 *  or makes the whole body shrink for its full height, which is a narrower column and not a wrap. The
 *  markdown block is the one element in the chain with ordinary block flow and real line boxes. A turn
 *  ending in tool rows, a diff or an image therefore has no wrap target, and the caller falls back to
 *  clearing that overlap vertically instead. */
const wrapTarget = (transcript: HTMLElement): HTMLElement | null => {
  const turns = transcript.querySelectorAll<HTMLElement>('[data-tk]');
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn) return null;
  const prose = lastTurn.querySelectorAll<HTMLElement>('.chat-markdown');
  return prose[prose.length - 1] ?? null;
};

/** Only this editor subscribes to draft changes. The shared controller still owns the draft and send
 *  actions, but a keystroke does not render the transcript, top bar, cards or telemetry. */
function ChatComposer({ variant, composerRef, pinToNewest }: {
  variant: 'full' | 'compact';
  composerRef: RefObject<HTMLTextAreaElement | null>;
  pinToNewest: () => void;
}) {
  const { t } = useTranslation();
  const { setInput, attachments, addFiles, submit, commands, runSlash, queued, onQueueRemove, busy, abort } = useBrainChat();
  const input = useBrainChatInput();
  const [slashIdx, setSlashIdx] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const slashQuery = input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const slashItems = (slashQuery !== null ? commands.filter((command) => command.name.startsWith(slashQuery)) : [])
    .map((command) => ({ key: command.name, label: `/${command.name}`, desc: command.description, run: () => runSlash(command) }));
  const slashOpen = slashItems.length > 0;
  const slashSel = Math.min(slashIdx, slashItems.length - 1);

  const previousInput = useRef<string | null>(null);
  // Appending cannot make this plain-text field shorter. Keep its current height while measuring normal
  // typing; resetting it to auto on every key invalidates the layout of the entire long conversation.
  // Deletions, replacements and restored drafts still reset the height so the editor can shrink.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const before = el.offsetHeight;
    if (previousInput.current === null || !input.startsWith(previousInput.current)) el.style.height = 'auto';
    const height = `${el.scrollHeight}px`;
    if (el.style.height !== height) el.style.height = height;
    previousInput.current = input;
    // Only a changed reading area asks the surface to follow. The shared writer still respects a reader
    // scrolled into history, and CSS keeps the field capped when it needs its own scrollbar.
    if (el.offsetHeight !== before) pinToNewest();
  }, [input, composerRef, pinToNewest]);

  return (
      <form
        className={variant === 'full'
          ? 'chat-composer relative flex items-end gap-1 rounded-2xl border border-border bg-card p-1.5 transition-colors focus-within:border-border-strong'
          : 'relative flex items-end gap-2 p-2'}
        onSubmit={(e) => {
          e.preventDefault();
          const invocation = parseSlashInvocation(input, commands);
          // Prompt macros and unknown slash-prefixed prose are real chat turns. A published daemon command
          // with arguments is executed through the same catalog path as a menu pick; local pickers keep their
          // previous argument-bearing text behaviour unless the menu invoked them bare.
          if (invocation && invocation.command.kind !== 'prompt'
            && (!invocation.argument || invocation.command.execution === 'session-control')) {
            runSlash(invocation.command, invocation.argument);
            return;
          }
          void submit();
        }}
      >
        {slashOpen && (
          <div data-testid="chat-slash-menu" className={`absolute bottom-full w-full max-w-md overflow-hidden rounded-lg border border-border bg-muted shadow-lg ${variant === 'full' ? 'left-0 mb-2' : 'left-2 mb-1'}`}>
            <div className="max-h-60 overflow-y-auto py-1">
              {slashItems.map((it, i) => (
                <button
                  key={it.key}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); it.run(); }}
                  onMouseEnter={() => setSlashIdx(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === slashSel ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`}
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
          className={`flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
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
          className={`max-h-[min(10rem,22dvh)] flex-1 resize-none text-sm text-foreground placeholder:text-muted-foreground ${
            variant === 'full'
              ? 'bg-transparent px-2 py-2 focus:outline-none'
              : 'rounded-lg border border-border bg-background px-3 py-2 focus:border-primary'
          }`}
        />
        {/* The work-mode switch sits immediately left of send/stop, at the same 36px height, on every
            surface — the mode the NEXT send is stamped with belongs beside the control that stamps it. */}
        <WorkModeSwitch variant={variant === 'full' ? 'full' : 'compact'} />
        {busy ? (
          <button
            type="button"
            data-testid="chat-stop"
            onClick={abort}
            aria-label={t.brainChat.stop}
            /* `animate-stop-pulse` must stay a literal class in TSX: it is a plain CSS class defined once
               in app/styles/animations.css, so Tailwind's content purge keeps it only because it sees the
               string here. While a turn runs the button breathes a slow primary halo (see stop-pulse);
               hover/focus stay readable on top of it, and quiet-effects/reduced-motion silence it. */
            className={`animate-stop-pulse flex h-9 w-9 shrink-0 items-center justify-center transition-colors ${
              variant === 'full'
                ? 'rounded-xl bg-primary text-foreground hover:bg-primary-hot'
                : 'rounded-lg border border-primary bg-primary/15 text-primary hover:bg-primary/25'
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
                ? 'rounded-xl bg-primary text-foreground hover:bg-primary-hot'
                : 'rounded-lg border border-primary bg-primary/15 text-primary hover:bg-primary/25'
            }`}
          >
            <Send size={16} aria-hidden />
          </button>
        )}
      </form>
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
    turns, busy, ready, notice, ask, cards, artifacts, narration, agentsOpen, setAgentsOpen, statsOpen, setStatsOpen,
    reasoningOpen, setReasoningOpen, skillsOpen, setSkillsOpen, tasksOpen, setTasksOpen, pluginPicker, closePluginPicker,
    helpOpen, setHelpOpen, modelOpen, setModelOpen, queued, readOnly,
    usage, goal, lineCfg, currentModel, provider, providerLabel, subagents, attachments, removeAttachment, switchSession,
    openReadOnly, exitReadOnly, onQueueRemove, onAnswer, sessions, activeSessionId, focusNonce,
    ensureAttached, loadOlder, hasMoreHistory, showThoughts,
    planDecision, implementPlan, dismissPlan, planSubmitting, renameOpen, closeRename, renameSession,
    registerSurface,
  } = c;

  // Whichever plugin picker the controller currently has open, resolved through the surface's own
  // renderer registry. Null while none is open, and null for a name this build cannot draw.
  const PluginPicker = pluginPickerComponent(pluginPicker);

  // Tell the provider a chat is on screen. It sits above every route, so the reconnect overlay it owns
  // must only cover the app while there is actually a conversation to protect — not while the reader is
  // on the dashboard.
  useEffect(() => registerSurface(), [registerSurface]);

  /** What an inline plugin artifact is told about a prompt waiting on the user (plugin UI API 15).
   *
   *  An artifact that expands into its own surface covers this surface — the question card included — so
   *  a reader watching, say, a live browser never learns that the agent stopped to ask them something.
   *  The contract is deliberately contentless: the app's own translated line, plus the way back to the
   *  card that owns answering. Nothing about the question crosses into a bundle, and nothing a bundle
   *  draws can drift from what the user is actually being asked.
   *
   *  `reveal` belongs to THIS surface, not to a lookup: a phone with the dock open on /chat mounts two,
   *  and each one hands its own artifacts its own card. */
  const pendingInput = useMemo<PluginChatPendingInput | null>(() => (ask ? {
    label: t.brainChat.askWaiting,
    reveal: () => {
      const card = askRef.current;
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.focus({ preventScroll: true });
    },
  } : null), [ask, t.brainChat.askWaiting]);

  const [pickerOpen, setPickerOpen] = useState(false);
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
  const activeSurfaceGoal = goal?.status === 'active' && !railOwnsLiveWork ? goal : null;
  const hasStatuslineStats = !!lineCfg && (lineCfg.showModel || lineCfg.showContext || lineCfg.showTokens || lineCfg.showSpeed || lineCfg.showCost);
  // `undefined` until the viewport has actually been measured. Every branch below therefore tests `=== true`
  // or `=== false` and renders NOTHING in between: the boolean-returning hook reports `false` first, which
  // on a phone painted one frame of the desktop controls (inline picker, mode pill, reasoning button) before
  // swapping them for the ⋯ menu. A bar that is briefly missing a control is quieter than one that visibly
  // rearranges itself. Same approach as ChatView, which reads this hook for its own layout.
  const mobile = useMobileViewport();
  // The transcript's out-of-band extras (TODO cards, agents chip) wait for the measurement too: rendering
  // them while the viewport is still unknown paints them once on a phone before the layout resolves.
  const transcriptExtras = mobile !== undefined;
  // Whether the rail's Tasks section is actually RENDERING this conversation's checklist right now — the
  // exact condition TelemetryPanel builds its rows from, so the transcript can only hand the rows over to
  // a section that has them. Structured card rows are enough on their own; a legacy card (rows without
  // ids) is shown by the rail only once its session-task fallback has answered, and while that query is
  // loading — or has failed — the rail shows nothing at all. React Query shares the fetch with the rail's
  // own `useSessionTasks`, so consulting it here costs no extra request.
  const railCardRows = useMemo(() => cardTasks(cards), [cards]);
  const railRowsAddressable = cardTasksAddressable(railCardRows);
  const railFallback = useSessionTasks(
    railOwnsLiveWork && railCardRows.length > 0 && !railRowsAddressable ? activeSessionId : null,
  );
  const railShowsTasks = railOwnsLiveWork && railCardRows.length > 0
    && (railRowsAddressable || (railFallback.data?.tasks.length ?? 0) > 0);
  // TODO cards with open work (CardBlock hides a card whose every item is done). The phone bar has no room
  // for a control of its own, so the ⋯ menu opens them in a dialog instead.
  //
  // A visible docked rail reports the same checklist ROWS in its Tasks section, where they are also
  // tickable, so repeating them under the transcript would announce the same work twice — the rule the
  // agents chip above already follows. It is the rows the rail takes over, not the card: a card carrying
  // freeform `body` still belongs here, because the rail has nowhere to put that body. Only the TODO card
  // is ever handed over — another plugin's card is not task-shaped and the rail never lists it. A phone
  // (no docked rail, `telemetryShown` undefined) and a collapsed rail both keep the card exactly as before.
  const todoCards = cards.filter((cd) => {
    if (isBackgroundProcessCardId(cd.id)) return false;
    const items = cd.items ?? [];
    if (railShowsTasks && cd.id === TODO_CARD_ID && items.length > 0 && !cd.body) return false;
    return items.length === 0 ? true : !items.every((i) => i.status === 'completed');
  });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  // Lazy-load (scroll-up) state. `loadingOlder` drives the top spinner.
  // The prepend anchor rides on a real turn ELEMENT: at scroll-trigger we grab the topmost turn node and its
  // offsetTop; after older turns land above it, we shift scrollTop by exactly how far that node moved. Node
  // offsetTop is immune to below-viewport growth (cards / ask / agents / process panel) and to a stream
  // delta landing during the fetch, both of which broke a scrollHeight-delta anchor.
  const [loadingOlder, setLoadingOlder] = useState(false);
  // THE scroll state. `followNewestRef` owns whether layout changes keep the newest turn visible;
  // `userScrollUntilRef` is a short causal window in which a browser `scroll` event may be trusted as
  // reader-driven rather than as a side effect of focus, anchoring or one of our own writes.
  const followNewestRef = useRef(true);
  const userScrollUntilRef = useRef(0);
  // The offset the surface itself last wrote, so the `scroll` event that write causes is not mistaken
  // for the reader moving. -1 is "nothing written yet", which no real offset equals.
  const ownWriteAtRef = useRef(-1);
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

  // ── THE SCROLL CONTRACT ────────────────────────────────────────────────────────────────────────────
  // One invariant owns every scroll write in this component: while `followNewestRef` is true the transcript
  // shows its newest turn, and each REAL layout change re-pins it there; the pin is released only by the
  // reader scrolling away from the bottom, and nothing else writes the offset. This is the single writer —
  // it self-gates, so no caller has to re-check the flag and no two callers can disagree about it.
  const pinToNewest = useCallback((): void => {
    const s = getScroller();
    if (!s || !followNewestRef.current) return;
    s.scrollTo({ top: s.scrollHeight });
    // Read the offset BACK rather than assuming `scrollHeight`: the browser clamps the write, and the
    // clamped value is what the resulting `scroll` event will report. Remembering it is what lets the
    // handler below discard the surface's own writes even after the reader has been marked engaged —
    // `keydown` bubbles out of the composer and `pointerdown` out of any click inside the scroller, so
    // engagement is a coarse signal and must never be the only thing standing between a pin write and
    // the event it causes.
    ownWriteAtRef.current = s.scrollTop;
  }, [getScroller]);

  // Re-entering a conversation is an explicit request to see its newest turn: the pin goes back on, and the
  // previous visit's intent window is cleared so a stale `scroll` event cannot release it again.
  const followNewestAgain = useCallback((): void => {
    followNewestRef.current = true;
    userScrollUntilRef.current = 0;
    pinToNewest();
  }, [pinToNewest]);

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


  // First mount of ANY chat surface (dock opened in chat mode) lazily boots the controller. Idempotent —
  // a second mount (or the BRAIN_* window events) never re-runs brainStart, so a one-shot mount call is
  // enough (and avoids re-firing on the controller's per-render identity churn).
  useEffect(() => { ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Entering the full chat route always opens at the newest turn. The shell <main> survives route changes,
  // so neither its old scrollTop nor the previous visit's engagement may become this visit's chat state.
  //
  // The ResizeObserver is what makes the guarantee LAYOUT-driven instead of timing-driven, and it replaces
  // the rAF this used to also fire: a frame is a guess about when the transcript has settled, whereas a
  // resize IS the transcript settling. Late markdown, a decoded image, a web font and the toolbar portal
  // each resize the transcript, and each one lands the newest turn back at the bottom — however many
  // frames after mount it happens.
  useLayoutEffect(() => {
    if (variant !== 'full') return;
    followNewestAgain();
    const transcript = scrollRef.current;
    const observer = transcript && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => pinToNewest()) : null;
    if (transcript) observer?.observe(transcript);
    return () => observer?.disconnect();
  }, [variant, followNewestAgain, pinToNewest]);

  // Opening another conversation is an explicit request to see that conversation's newest message. Reset
  // every scroll/prepend guard before its snapshot lands; otherwise a chat opened while the previous one
  // was scrolled up inherited a released pin and rendered at the old page offset.
  useLayoutEffect(() => {
    if (!activeSessionId || activeSessionId === previousSessionRef.current) return;
    previousSessionRef.current = activeSessionId;
    prevTurnsRef.current = [];
    anchorNodeRef.current = null;
    followNewestAgain();
  }, [activeSessionId, followNewestAgain]);

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
      if (anchor) {
        s.scrollTop += anchor.offsetTop - anchorTopRef.current;
        ownWriteAtRef.current = s.scrollTop;
      }
      anchorNodeRef.current = null;
    } else {
      pinToNewest();
    }
    prevTurnsRef.current = turns;
  }, [turns, variant, getScroller, pinToNewest]);

  // Watch the live scroll position: track "near the bottom" (the stick-to-newest gate above) and load the
  // next older page when the reader nears the top. Bound imperatively because the scroller is sometimes the
  // shell <main>, not a node this component renders; rebinds only when the resolver changes (variant) —
  // the trigger is read through a ref so a per-render identity can't churn the bind.
  useEffect(() => {
    const s = getScroller();
    if (!s) return;
    let touchY: number | null = null;
    let scrollbarPointer: number | null = null;

    // Release immediately on genuine reader intent, before the browser's later `scroll` event. Otherwise a
    // streaming render can win that gap and pin the transcript back down. Clearing our remembered write also
    // prevents the reader's first offset from being mistaken for a delayed event from that write.
    const markReaderScroll = (): void => {
      followNewestRef.current = false;
      ownWriteAtRef.current = -1;
      userScrollUntilRef.current = performance.now() + USER_SCROLL_WINDOW_MS;
    };
    const onWheel = (event: WheelEvent): void => {
      if (!event.isTrusted) return;
      if (event.deltaY < 0 || !followNewestRef.current) markReaderScroll();
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (!event.isTrusted) return;
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!event.isTrusted) return;
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY !== null && (touchY === null || nextY > touchY || !followNewestRef.current)) markReaderScroll();
      touchY = nextY;
    };
    const onTouchEnd = (): void => { touchY = null; };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.isTrusted || !SCROLL_KEYS.has(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body && !s.contains(target)) return;
      if (target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      const movesUp = event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey);
      if (movesUp || !followNewestRef.current) markReaderScroll();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.isTrusted) return;
      const rect = s.getBoundingClientRect();
      const gutter = Math.max(0, s.offsetWidth - s.clientWidth);
      const hitsVerticalScrollbar = event.target === s && gutter > 0 && event.clientX >= rect.right - gutter;
      if (!hitsVerticalScrollbar) return;
      scrollbarPointer = event.pointerId;
      markReaderScroll();
    };
    const onPointerEnd = (event: PointerEvent): void => {
      if (event.pointerId === scrollbarPointer) scrollbarPointer = null;
    };
    const onScroll = (): void => {
      // Our own write, arriving back as an event — never the reader.
      if (s.scrollTop === ownWriteAtRef.current) return;
      const now = performance.now();
      const readerDriven = scrollbarPointer !== null || now <= userScrollUntilRef.current;
      if (!readerDriven) return;
      // Wheel smoothing and touch momentum can continue after the final input event. Every causally-linked
      // scroll extends the window so the final offset can re-enable following when momentum reaches bottom.
      userScrollUntilRef.current = now + USER_SCROLL_WINDOW_MS;
      followNewestRef.current = s.scrollHeight - s.scrollTop - s.clientHeight < BOTTOM_GAP;
      // Entry pins and browser-driven focus/anchoring are never requests for older history. Only an offset
      // causally tied to a reader gesture may cross this boundary.
      if (!followNewestRef.current && s.scrollTop < OLDER_TRIGGER) triggerOlderRef.current();
    };

    s.addEventListener('scroll', onScroll, { passive: true });
    s.addEventListener('wheel', onWheel, { passive: true });
    s.addEventListener('touchstart', onTouchStart, { passive: true });
    s.addEventListener('touchmove', onTouchMove, { passive: true });
    s.addEventListener('touchend', onTouchEnd, { passive: true });
    s.addEventListener('touchcancel', onTouchEnd, { passive: true });
    const keyTarget: EventTarget = variant === 'full' ? window : s;
    keyTarget.addEventListener('keydown', onKeyDown as EventListener);
    s.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
    return () => {
      s.removeEventListener('scroll', onScroll);
      s.removeEventListener('wheel', onWheel);
      s.removeEventListener('touchstart', onTouchStart);
      s.removeEventListener('touchmove', onTouchMove);
      s.removeEventListener('touchend', onTouchEnd);
      s.removeEventListener('touchcancel', onTouchEnd);
      keyTarget.removeEventListener('keydown', onKeyDown as EventListener);
      s.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [getScroller, variant]);

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


  // Mobile keyboards have two viewport policies. Chromium honours `interactive-widget=resizes-content`,
  // so the layout viewport itself shrinks; iOS keeps the layout viewport tall and shrinks only
  // `visualViewport`. The sticky dock therefore needs only the VISUAL bottom offset in the latter case.
  // Its measured height is also the transcript's reserve: the dock overlaps that padding rather than
  // obscuring the final turn. Safe-area padding is disabled while the keyboard is open because the visual
  // viewport already ends above the keyboard/home indicator — adding it again creates the blank band from
  // the screenshot.
  useLayoutEffect(() => {
    if (variant !== 'full') return;
    const root = surfaceRootRef.current;
    const dock = composerDockRef.current;
    const composer = composerRef.current;
    if (!root || !dock || !composer) return;

    const viewport = window.visualViewport;
    const viewportHeight = () => window.visualViewport?.height ?? window.innerHeight;
    const viewportWidth = () => window.visualViewport?.width ?? window.innerWidth;
    let restingHeight = viewportHeight();
    let restingWidth = viewportWidth();
    let keyboardWasOpen = false;
    let frame = 0;
    let baselineFrame = 0;
    let baselineSettleFrame = 0;
    const setPx = (name: string, value: number) => {
      const next = `${Math.max(0, Math.round(value))}px`;
      if (root.style.getPropertyValue(name) !== next) root.style.setProperty(name, next);
    };
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const currentViewport = window.visualViewport;
        const currentHeight = viewportHeight();
        const currentWidth = viewportWidth();
        const focused = document.activeElement === composer;
        const restingLandscape = restingWidth > restingHeight;
        const currentLandscape = currentWidth > currentHeight;
        const layoutRotated = focused && keyboardWasOpen
          && Math.abs(currentWidth - restingWidth) >= 1
          && currentLandscape !== restingLandscape;
        if (layoutRotated) {
          // A focused keyboard survives rotation. Project the new resting height from the previous layout's
          // width (the axes exchanged) instead of comparing the new portrait/landscape viewport against a
          // baseline from the old orientation, which can falsely close the keyboard in one direction.
          const previousRestingWidth = restingWidth;
          restingWidth = currentWidth;
          restingHeight = previousRestingWidth;
        }
        const keyboardOpen = focused && (currentHeight < restingHeight - 1 || layoutRotated);
        keyboardWasOpen = keyboardOpen;
        const visualBottomOffset = keyboardOpen && currentViewport
          ? (window.innerHeight - currentViewport.offsetTop - currentViewport.height) / uiZoom()
          : 0;

        root.dataset.chatKeyboardOpen = keyboardOpen ? 'true' : 'false';
        setPx('--chat-visual-bottom-offset', visualBottomOffset);
        setPx('--chat-composer-height', dock.offsetHeight);
        // The viewport or dock changed the available reading area. Keep following only for a reader who
        // was already at the newest turn; `pinToNewest` deliberately does nothing while they read history.
        pinToNewest();
      });
    };
    const updateRestingHeightWhenStable = () => {
      cancelAnimationFrame(baselineFrame);
      cancelAnimationFrame(baselineSettleFrame);
      const sampledHeight = viewportHeight();
      const sampledWidth = viewportWidth();
      baselineFrame = requestAnimationFrame(() => {
        baselineSettleFrame = requestAnimationFrame(() => {
          if (document.activeElement === composer) return;
          const stableHeight = viewportHeight();
          const stableWidth = viewportWidth();
          if (Math.abs(stableHeight - sampledHeight) >= 1 || Math.abs(stableWidth - sampledWidth) >= 1) return;
          restingHeight = stableHeight;
          restingWidth = stableWidth;
          keyboardWasOpen = false;
          measure();
        });
      });
    };
    const onViewportResize = () => {
      measure();
      updateRestingHeightWhenStable();
    };

    measure();
    window.addEventListener('resize', onViewportResize);
    viewport?.addEventListener('resize', onViewportResize);
    viewport?.addEventListener('scroll', measure);
    composer.addEventListener('focus', measure);
    composer.addEventListener('blur', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(baselineFrame);
      cancelAnimationFrame(baselineSettleFrame);
      window.removeEventListener('resize', onViewportResize);
      viewport?.removeEventListener('resize', onViewportResize);
      viewport?.removeEventListener('scroll', measure);
      composer.removeEventListener('focus', measure);
      composer.removeEventListener('blur', measure);
      observer?.disconnect();
      root.style.removeProperty('--chat-visual-bottom-offset');
      root.style.removeProperty('--chat-composer-height');
      delete root.dataset.chatKeyboardOpen;
    };
  }, [variant, pinToNewest]);

  // Clearance under the transcript for a docked plugin card — today the browser monitor, which floats just
  // above the composer and publishes its measured height back as `--chat-dock-height` on this surface.
  //
  // The card is a LAYER: it takes no room in the flow, so a conversation long enough to fill the page ends
  // UNDERNEATH it, and scrolling never brings those lines out. `scroll-margin-bottom` moves where autoscroll
  // comes to REST but does not extend the scroll RANGE, so the last turn stays covered at the bottom of the
  // page — which is exactly the report this fixes.
  //
  // Reserving the card's height unconditionally is what this replaces. The composer dock follows the
  // content rather than the viewport, so under a short conversation that reserve became a tall empty band
  // below the last message. The reserve here is geometric instead: it exists only while the transcript's
  // content would actually come to rest inside the card's zone, and stays 0 for every conversation that
  // ends above it.
  //
  // HYSTERESIS. Both terms are compared against the layout WITHOUT the current reserve — the applied value
  // is subtracted from the dock's measured top, which is the only thing the reserve moves (the content
  // above it does not shift). Applying a reserve therefore cannot change the answer that asked for it, so
  // the two states cannot oscillate. Measuring the dock's real rect rather than recomputing from the CSS
  // variables also keeps this correct while the visual viewport shifts the sticky dock.
  //
  // The plugin owns the card and writes `--chat-dock-height` as an inline style. Its API is fixed and
  // read-only from here, so the style attribute IS the seam, and a MutationObserver is how this side reads
  // it. Nothing docked means no variable, no reserve, and no work beyond one comparison.
  useLayoutEffect(() => {
    if (variant !== 'full') return;
    const root = surfaceRootRef.current;
    const transcript = scrollRef.current;
    const dock = composerDockRef.current;
    if (!root || !transcript || !dock) return;

    let frame = 0;
    let wrapped: HTMLElement | null = null;
    /** Take the wrap off, everywhere it might still be on. Also the teardown path. */
    const clearWrap = (): void => {
      if (!wrapped) return;
      wrapped.removeAttribute('data-chat-dock-wrap');
      wrapped.style.removeProperty('--chat-dock-spacer-top');
      wrapped = null;
    };
    const setReserve = (px: number): boolean => {
      const next = px > 0 ? `${Math.round(px)}px` : '';
      if (transcript.style.getPropertyValue('--chat-dock-reserve') === next) return false;
      if (next) transcript.style.setProperty('--chat-dock-reserve', next);
      else transcript.style.removeProperty('--chat-dock-reserve');
      return true;
    };

    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const cardHeight = parseFloat(root.style.getPropertyValue('--chat-dock-height')) || 0;
        const target = cardHeight > 0 ? wrapTarget(transcript) : null;

        // PHASE ONE — measure the layout the wrap is NOT in. The float makes its own block taller, so a
        // margin computed from a wrapped block would feed its own growth back in and never settle. The
        // spacer therefore goes off before anything is read, in this same frame, and only comes back at
        // the end; the reserve is subtracted from the dock for exactly the same reason.
        const previous = wrapped;
        previous?.removeAttribute('data-chat-dock-wrap');
        const applied = parseFloat(transcript.style.getPropertyValue('--chat-dock-reserve')) || 0;
        const gap = DOCK_CARD_GAP_REM * remPx();
        const zoneBottom = dock.getBoundingClientRect().top - applied - gap;
        const zoneTop = zoneBottom - cardHeight;
        const content = cardHeight > 0 ? lastContentRect(transcript) : null;
        const targetHeight = target ? target.getBoundingClientRect().height : 0;
        const card = cardHeight > 0 ? dockedCardRect(root, cardHeight) : null;

        // Nothing docked, or a conversation that ends above the card: no wrap, no reserve, no band.
        if (!card || !content || content.bottom <= zoneTop) {
          clearWrap();
          previous?.style.removeProperty('--chat-dock-spacer-top');
          if (setReserve(0)) pinToNewest();
          return;
        }

        // PHASE TWO — place the wrap. The spacer sits at the START of the prose block (a float may not be
        // higher than the line boxes before it), pushed down so its box covers the block's LAST
        // `cardHeight` pixels, which is where the card actually is.
        const spacerTop = Math.max(0, targetHeight - cardHeight);
        // Whatever the wrap cannot clear. The wrapped block looks after itself, so what is left is the
        // content ABOVE it — earlier turns the card's zone still reaches over when the block is shorter
        // than the card. Clearing them means pushing the card down to the block's top edge, and no
        // further: the reserve moves the dock (and with it the absolutely positioned card) rather than the
        // content, so `target.top - zoneTop` is exactly the deficit and never a whole card height. With no
        // wrap target at all (a turn ending in tool rows or an image) the same measure falls back to the
        // real end of the content.
        const reserve = Math.max(0, (target ? target.getBoundingClientRect().top : content.bottom) - zoneTop);

        // Guarded: this lands on the SAME style attribute the MutationObserver below watches, so an
        // unconditional write would re-enter this measurement every frame, forever.
        const width = `${Math.round(card.width)}px`;
        if (root.style.getPropertyValue('--chat-dock-width') !== width) {
          root.style.setProperty('--chat-dock-width', width);
        }
        if (target) {
          target.style.setProperty('--chat-dock-spacer-top', `${Math.round(spacerTop)}px`);
          if (previous && previous !== target) {
            previous.removeAttribute('data-chat-dock-wrap');
            previous.style.removeProperty('--chat-dock-spacer-top');
          }
          target.setAttribute('data-chat-dock-wrap', 'on');
          wrapped = target;
        } else {
          clearWrap();
          previous?.style.removeProperty('--chat-dock-spacer-top');
        }
        if (setReserve(reserve)) pinToNewest();
      });
    };

    measure();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(transcript);
    resize?.observe(dock);
    // A new last turn, or a turn that grew a new segment, changes what the wrap rides on.
    const children = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    children?.observe(transcript, { childList: true, subtree: true });
    // The surface's own style attribute carries `--chat-dock-height` (the plugin) and the composer
    // measurements (the effect above); both move the card, so both are worth a remeasure.
    const style = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    style?.observe(root, { attributes: true, attributeFilter: ['style'] });
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      children?.disconnect();
      style?.disconnect();
      clearWrap();
      transcript.style.removeProperty('--chat-dock-reserve');
      root.style.removeProperty('--chat-dock-width');
    };
  }, [variant, pinToNewest]);

  const newChat = () => { setPickerOpen(false); void switchSession({ fresh: true }).catch(() => toast(t.brainChat.searchOpenError, 'error')); };

  return (
    <div
      ref={surfaceRootRef}
      className={`relative flex flex-col ${variant === 'full' ? 'chat-surface-full flex-1' : 'h-full min-h-0'}`}
      data-variant={variant}
    >
      {/* Conversation bar. Compact (dock): title + picker dropdown + new chat. Full (/chat): a light
          header — the shared history rail owns the session list, so here it is only the title, a mobile
          drawer toggle and new chat. */}
      {variant === 'compact' ? (
        <div className="relative flex items-center gap-1 border-b border-border px-2 py-1.5">
          {/* The conversation's name is the switcher here too, and it is a real `PopoverTrigger`: the
              `aria-expanded` / `aria-controls` pair, Escape, the outside press and the focus that comes
              back to this button on close are all Radix's, rather than four behaviours this bar would
              otherwise have to write and keep in step. `Popover.Root` renders no element of its own, so
              the trigger stays a plain flex item of the bar and the panel stays out of the flow. */}
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              {/* No `aria-label` here on purpose: the visible label IS the conversation title, and an
                  override would replace it in the accessible name — hiding the one piece of information
                  this control carries and leaving the spoken name unable to match what is on screen.
                  The trigger's own `aria-expanded` / `aria-haspopup` already say that it discloses. */}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <span className="truncate">{active?.title || t.brainChat.newChat}</span>
                <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </PopoverTrigger>
            <ChatHistoryRail variant="dropdown" onClose={() => setPickerOpen(false)} />
          </Popover>
          <ProjectPicker variant="compact" />
          <ModelPicker variant="compact" />
          <ReasoningButton onOpen={() => setReasoningOpen(true)} />
          <button
            type="button"
            onClick={newChat}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus size={16} aria-hidden />
          </button>
        </div>
      ) : (
        <PageTopBarPortal>
        <div className="chat-gutter chat-page-toolbar sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-1.5 bg-background py-2">
          {/* These controls ride in the shell's top rule at every width that publishes one — a phone
              included. Only the frameless design, which has no page slot, keeps this as its own local
              sticky bar. */}
          <div aria-hidden className="chat-page-toolbar__fade pointer-events-none absolute inset-x-0 top-full h-4 bg-gradient-to-b from-background to-transparent" />
          {/* The conversation's own name is the switcher: the one thing a reader looks for when they want
              another conversation is the name of this one. It opens the shared history drawer (list,
              search, rename, new) — no second list, no second control. */}
          {onOpenHistory ? (
            <button
              type="button"
              onClick={onOpenHistory}
              aria-label={t.chat.openHistory}
              title={t.chat.openHistory}
              data-testid="chat-conversation-switcher"
              className="chat-conversation-switcher flex h-8 min-w-0 max-w-[18rem] shrink items-center gap-1 rounded-md px-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <span className="truncate">{active?.title || t.brainChat.newChat}</span>
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            </button>
          ) : null}
          {/* On a phone the model picker folds into the ⋯ menu below; on desktop it stays inline. The
              work mode does not ride the toolbar any more: the composer's WorkModeSwitch is its single
              indicator and control on every surface. */}
          {mobile === false ? (
            <div className="chat-page-toolbar__wide-controls flex shrink-0 items-center gap-1.5">
              <ProjectPicker variant="full" />
              <ModelPicker variant="full" />
            </div>
          ) : null}
          {/* Reasoning and telemetry are one-tap actions at every width, beside the overflow. */}
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
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Activity size={18} aria-hidden />
            </button>
          ) : null}
          {mobile !== true ? (
          <button
            type="button"
            onClick={newChat}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus size={18} aria-hidden />
          </button>
          ) : null}
          {/* Phones and narrow desktops fold the wide pickers behind ⋯; roomy desktops keep them inline. */}
          {mobile !== undefined ? (
            <div className={mobile ? '' : 'chat-page-toolbar__overflow'}>
              <BarOverflowMenu
                folded={mobile}
                onOpenTasks={() => setTasksOpen(true)}
                onNewChat={newChat}
              />
            </div>
          ) : null}
        </div>
        </PageTopBarPortal>
      )}

      {/* Messages. The full /chat variant flows full-width and lets the page scroll (no inner scroll box);
          turns stack with NO container gap — each segment carries its own margin, so tool rows keep one
          uniform rhythm across turn boundaries and only a speaker change opens a block break. The compact
          dock keeps its own internal scroll and per-turn gap. */}
      <div ref={scrollRef} data-testid="chat-transcript" className={`flex flex-1 flex-col ${variant === 'full' ? 'chat-gutter chat-transcript' : 'gap-3 min-h-0 overflow-y-auto p-3'}`}>
        {turns.length === 0 && ready ? (
          variant === 'full' ? (
            <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
              <p className="text-lg font-medium text-foreground">{t.chat.emptyTitle}</p>
              <p className="text-sm text-muted-foreground">{t.brainChat.empty}</p>
            </div>
          ) : (
            <p className="m-auto max-w-[220px] text-center text-xs text-muted-foreground">{t.brainChat.empty}</p>
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
              artifacts={artifacts}
              narration={narration}
              pendingInput={pendingInput}
              models={c.models ?? undefined}
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
            data-testid="chat-agents-open"
            onClick={() => setAgentsOpen(true)}
            className="flex items-center gap-1.5 self-start leading-relaxed text-muted-foreground transition-colors hover:text-foreground"
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
        {/* The picker a plugin declared and this surface draws (see pluginPickers.tsx). One mount for
            every such command: the controller says which name is open, the registry says what draws it,
            and neither of them knows what any particular plugin's chooser does. */}
        {PluginPicker ? (
          <PluginPicker onClose={closePluginPicker} />
        ) : null}
        {helpOpen ? (
          <HelpModal onClose={() => setHelpOpen(false)} />
        ) : null}
        {modelOpen ? (
          <ModelModal onClose={() => setModelOpen(false)} />
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
          // Wrapped and focusable so `pendingInput.reveal` has something to bring the reader to: a plugin
          // artifact expanded over the dock hides this card, and the way back has to be the card itself.
          <div ref={askRef} tabIndex={-1} className="scroll-mt-4 focus:outline-none">
            <AskQuestionCard
              key={ask.id}
              questions={ask.questions}
              kind={ask.kind}
              onSubmit={(answers) => onAnswer(ask.id, answers)}
            />
          </div>
        ) : null}
        </div>
      </div>

      {/* Composer footer (statusline + staged attachments + queue + composer). In the full page it sticks
          to the viewport bottom so it stays reachable while the whole page scrolls behind it; the compact
          dock keeps it in normal flow at the bottom of its own scroll box.

          `.chat-composer-dock` (chat.css) carries the bottom safe-area inset. Without it the composer's
          send button sits UNDER a phone's home indicator: the dock is pinned at `bottom: 0`, which is the
          edge of the viewport, not the edge of the usable screen. */}
      {/* No hairline and NO fade above the footer: a gradient over the transcript's last lines read as
          "there is more below" and had readers scrolling for text that was never hidden. The dock's own
          opaque background is the only edge. */}
      <div ref={composerDockRef} data-testid="chat-composer-dock" className={variant === 'full' ? 'chat-composer-dock sticky z-10 bg-background' : ''}>
      {/* One-line server status notice when the daemon sends one. The running state itself is signalled by
          the composer's Stop button (no separate "thinking" spinner). Hidden while a question is pending. */}
      {notice && !ask ? (
        <div className={`flex items-center gap-2 py-1.5 font-mono text-muted-foreground ${variant === 'full' ? 'chat-gutter text-[0.6875rem]' : 'px-3 text-tiny'}`}>
          <span className="italic opacity-80">{notice}</span>
        </div>
      ) : null}
      {/* Statusline (the statusline plugin's toggles decide what shows; hidden when disabled). A leading
          chevron collapses the whole row in-chat — the quick alternative to the plugin's settings, mainly
          for a phone where the metrics crowd the composer. Collapsed leaves only the chevron to bring it
          back. */}
      {activeSurfaceGoal || hasStatuslineStats ? (
        // Exactly ONE line, phone included: a second row here pushes the composer down and eats the little
        // vertical room a phone has. The goal is the high-priority prefix; optional statistics give way as
        // width tightens. Which statistic drops at which width is the `[data-stat]` ladder in chat.css.
        <div data-testid="chat-statusline" className={`chat-statusline flex min-w-0 items-center gap-x-2 overflow-hidden py-1 font-mono text-muted-foreground sm:gap-x-3 ${variant === 'full' ? 'chat-gutter text-[0.6875rem]' : 'px-3 text-tiny'}`}>
          {hasStatuslineStats ? (
            <button
              type="button"
              onClick={() => setStatuslinePref(statuslineShown ? 'hidden' : 'shown')}
              aria-expanded={statuslineShown}
              aria-label={statuslineShown ? t.chat.hideStats : t.chat.showStats}
              title={statuslineShown ? t.chat.hideStats : t.chat.showStats}
              className="flex shrink-0 items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight size={11} aria-hidden className={`opacity-60 transition-transform ${statuslineShown ? 'rotate-90' : ''}`} />
            </button>
          ) : null}
          {activeSurfaceGoal ? <GoalStatusInline goal={activeSurfaceGoal} /> : null}
          {hasStatuslineStats && statuslineShown && lineCfg ? (
            <>
              {lineCfg.showModel && (currentModel || active?.model) ? (() => {
                const model = currentModel || active?.model || '';
                const identity = {
                  provider: currentModel ? provider : (active?.provider ?? ''),
                  providerLabel: currentModel ? providerLabel : '',
                  model,
                };
                return (
                  <span data-stat="model" className="min-w-0 truncate" title={brainModelQualifiedLabel(identity)}>
                    {brainModelLabel(identity)}
                  </span>
                );
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
            <span key={i} title={a.relative} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted py-1 pl-1.5 pr-1 text-tiny text-foreground">
              <FileText size={13} className="text-muted-foreground" aria-hidden />
              <span className="max-w-[140px] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                aria-label={t.brainChat.attachRemove}
                className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
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
            <div key={q.id} className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-tiny">
              <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 font-medium uppercase tracking-wide text-primary">{t.brainChat.queued}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.text}</span>
              <button
                type="button"
                onClick={() => onQueueRemove(q.id)}
                aria-label={t.brainChat.removeFromQueue}
                title={t.brainChat.removeFromQueue}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
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
          <div className={`flex items-center justify-between gap-2 bg-muted/40 p-3 text-sm text-muted-foreground ${variant === 'full' ? 'rounded-xl border border-border' : ''}`}>
            <span className="flex min-w-0 items-center gap-2"><FileText size={14} className="shrink-0" aria-hidden /><span className="truncate">{t.brainChat.readOnly}</span></span>
            <button type="button" onClick={exitReadOnly} className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent">{t.brainChat.readOnlyExit}</button>
          </div>
        </div>
      ) : (
      <div className={variant === 'full' ? 'chat-gutter chat-composer-slot' : ''}>
      {/* In the full page the whole composer is ONE quiet rounded field (attach + textarea + send inside
          it, Claude-style); the dock keeps its original three-control row. */}
      <ChatComposer variant={variant} composerRef={composerRef} pinToNewest={pinToNewest} />
      </div>
      )}
      </div>
      {renameOpen ? (
        <RenameDialog
          current={active?.title ?? ''}
          onClose={closeRename}
          onSubmit={renameSession}
        />
      ) : null}
    </div>
  );
}
