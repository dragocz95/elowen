'use client';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Braces, ChevronDown, Clock3, Compass, Cpu, Gauge, GitBranch, Hammer, ListChecks, MessageSquarePlus, PanelRightClose, PanelRightOpen, PenLine, Server, Shrink, Target, TerminalSquare, Users, Workflow, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { plural } from '../../lib/i18n/plural';
import { interpolate } from '../../lib/i18n/interpolate';
import { elowenClient } from '../../lib/elowenClient';
import { useBrainProcesses, useBrainRateLimitsAll, useSessionTasks } from '../../lib/queries';
import { useUpdateSessionTask } from '../../lib/mutations';
import { formatTokens, formatCost, formatDuration } from '../../lib/format';
import { OAuthUsageRail, usageProgressClass, usageMeterValue, usageWindowLabel } from '../settings/OAuthUsageRail';
import { MascotGlyph } from '../../components/ui/SpatialMascot';
import { Dialog, DialogContent } from '../../components/ui/shadcn/dialog';
import { Badge } from '../../components/ui/shadcn/badge';
import { Button } from '../../components/ui/shadcn/button';
import { Progress } from '../../components/ui/shadcn/progress';
import { ScrollArea } from '../../components/ui/shadcn/scroll-area';
import { Separator } from '../../components/ui/shadcn/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/shadcn/collapsible';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { MorePill } from '../../components/ui/MorePill';
import { useToast } from '../../components/ui/Toast';
import { focusOverlaySurface, useReturnFocus } from '../../components/ui/overlayStack';
import { useNow } from '../../lib/useNow';
import { TODO_PREVIEW_ITEMS } from '../../lib/chatPresentation';
import { cardTasks, cardTasksAddressable, orderTasks, sessionTaskRows, type RailTask } from '../../lib/railTasks';
import { workflowLabel, workflowProgress } from '../../lib/workflowDag';
import { useBrainChat } from './BrainChatProvider';
import { useTelemetryRail } from './telemetryRailState';
import { ProcessOutputModal } from './ProcessPanel';
import { TodoRow, type TodoRowIds } from './TodoRow';
import { ownedSessionIds, isOwnProcess, processOrigin } from '../../lib/processScope';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../components/ui/shadcn/dropdown-menu';
import { goalSubgoalTally, useGoalElapsed } from './GoalStatus';
import type { BrainGoal, ProcessInfo } from '../../lib/types';

/** The owl presides over the rail the way it tops the CLI panel — and it is not decoration: it mirrors
 *  the agent, breathing while a turn runs and settling when it does not, so the rail reads as inhabited
 *  rather than a dashboard.
 *
 *  It is also the door to the command field: clicking it opens a dropdown of the slash commands worth
 *  reaching for mid-conversation — the work modes as a radio group, the one-off actions beneath a
 *  separator. The rows come from the daemon's catalog (`GET /brain/commands`, already surface-filtered)
 *  and execute through the controller's own `runSlash` — the menu is a second door onto the composer's
 *  slash menu, never a second implementation of it. A curated command that this account's surface does
 *  not expose simply has no row.
 *
 *  The flat glyph rather than the full WebGL mascot: that scene frames itself at a fixed pixel size, so a
 *  rail this narrow would crop it down to a pair of eyes.
 *
 *  `size` is a plain square in pixels rather than a share of the rail. In the redesigned head the mascot
 *  sits BESIDE the status text instead of above it, so its box is what the header row is built around; a
 *  percentage-sized owl would re-flow that row on every drag. */
const MASCOT_COMMANDS: readonly { name: string; icon: LucideIcon }[] = [
  { name: 'plan', icon: Compass },
  { name: 'build', icon: Hammer },
  { name: 'workflow', icon: Workflow },
  { name: 'compact', icon: Shrink },
  { name: 'rename', icon: PenLine },
  { name: 'new', icon: MessageSquarePlus },
  { name: 'model', icon: Cpu },
];

function TelemetryMascot({ busy, size }: { busy: boolean; size: number }) {
  const { t } = useTranslation();
  const { commands, runSlash, workMode } = useBrainChat();
  const field = t.brainChat.commandField;
  const labels: Record<string, string> = {
    plan: t.brainChat.workMode.plan,
    build: t.brainChat.workMode.build,
    workflow: t.brainChat.workMode.workflow,
    compact: field.compact,
    rename: field.rename,
    new: field.newChat,
    model: field.model,
  };
  // The catalog is surface-filtered, so a curated command the daemon withheld gets no row at all.
  const cataloged = MASCOT_COMMANDS.flatMap(({ name, icon }) => {
    const command = commands.find((c) => c.name === name);
    return command ? [{ command, icon }] : [];
  });
  const modeCommands = cataloged.filter(({ command }) => command.kind === 'mode');
  const actionCommands = cataloged.filter(({ command }) => command.kind !== 'mode');
  const run = (name: string): void => {
    const command = cataloged.find((c) => c.command.name === name)?.command;
    if (command) runSlash(command);
  };
  // The reader's-language hint where the dictionary has one; the catalog's English line otherwise.
  const hints: Record<string, string | undefined> = t.brainChat.commandHints;
  const hintFor = (name: string): string | undefined => hints[name] ?? cataloged.find((c) => c.command.name === name)?.command.description;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="telemetry-mascot"
          aria-label={field.open}
          title={field.open}
          style={{ width: size, height: size }}
          className="shrink-0 rounded-full transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <MascotGlyph state={busy ? 'saving' : 'idle'} />
        </button>
      </DropdownMenuTrigger>
      {/* `align="start"` keeps the panel anchored to the owl's left edge at either size the trigger
          renders at; Radix's collision handling is what stops it running off the viewport at the rail's
          edge. Click/keyboard only — a hover-open menu has no place above a live conversation. */}
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-52" data-testid="telemetry-mascot-menu">
        <DropdownMenuLabel>{field.title}</DropdownMenuLabel>
        {modeCommands.length > 0 ? (
          <DropdownMenuRadioGroup value={workMode} onValueChange={run}>
            {modeCommands.map(({ command, icon: Icon }) => (
              <DropdownMenuRadioItem key={command.name} value={command.name} data-testid={`telemetry-menu-${command.name}`}>
                <Icon size={14} aria-hidden className="shrink-0" />
                {labels[command.name] ?? command.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : null}
        {modeCommands.length > 0 && actionCommands.length > 0 ? <DropdownMenuSeparator /> : null}
        {actionCommands.map(({ command, icon: Icon }) => (
          <DropdownMenuItem key={command.name} data-testid={`telemetry-menu-${command.name}`} onSelect={() => run(command.name)}>
            <Icon size={14} aria-hidden className="mt-0.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{labels[command.name] ?? command.name}</span>
              {hintFor(command.name) ? <span className="truncate text-xs text-muted-foreground">{hintFor(command.name)}</span> : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The ONE heading every rail-body section shares: an icon in the left slot — the fold chevron where
 *  the section folds, the section's own glyph where it does not, so the left edge lines up either way —
 *  then the quiet uppercase label, then the meta on the right, always in the shared badge, so a
 *  percentage, a tally and a plan name wear the same treatment at the same size. */
function SectionHead({ label, icon, meta }: { label: string; icon?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="telemetry-section-head flex w-full min-w-0 items-center gap-1.5 text-xs uppercase tracking-wide text-subtle-foreground">
      {icon ?? null}
      {/* The label truncates like the meta does: it is a translated string, and at the narrow end of the
          rail an uppercase heading like "OTHER PROCESSES" is otherwise a width floor the row cannot go
          under, pushing the whole section past the column. */}
      <span className="min-w-0 truncate">{label}</span>
      {meta ? <span className="ml-auto shrink-0 truncate">{meta}</span> : null}
    </div>
  );
}

/** The shared right-aligned meta badge: one treatment for every section's count or value. */
function SectionMeta({ children }: { children: ReactNode }) {
  return <Badge variant="secondary" className="px-1 py-0 text-[10px] tabular-nums">{children}</Badge>;
}

/** A live-work section that can be folded away. Open by default and on every mount: these sections exist
 *  to be watched while they run, and a fold that persisted would hide a running agent from the one view
 *  that reports it. Folding is for the reader who wants the rail quiet right now, not a stored setting. */
function LiveSection({ label, count, testId, meter, listClassName = 'flex flex-col gap-0.5', children }: {
  label: string;
  count: ReactNode;
  testId: string;
  /** A meter shown above the rows, folding away with them. The tally stays in the head, which is what a
   *  folded section still has to report. */
  meter?: ReactNode;
  /** The row list's classes. The default spreads status rows a hair apart; the Tasks section passes the
   *  todo card's gapless list instead, because its rows carry their own padding. */
  listClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen data-testid={testId} className="flex flex-col gap-1">
      {/* The trigger owns only the fold behaviour; the row's layout is the shared SectionHead, whose
          icon slot the chevron occupies so a folded and a static section line up on the same edge. */}
      <CollapsibleTrigger className="group w-full text-left [&[data-state=open]_svg]:rotate-0 [&[data-state=closed]_svg]:-rotate-90">
        <SectionHead
          label={label}
          icon={<ChevronDown size={11} className="shrink-0 text-subtle-foreground transition-transform" aria-hidden />}
          meta={<SectionMeta>{count}</SectionMeta>}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {meter ? <div className="pb-1 pl-[18px]">{meter}</div> : null}
        <ul className={listClassName}>{children}</ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One clickable row of a live-work section: a status dot, a truncated label and an optional right-hand
 *  meta column. The label truncates rather than reserving a width, so the row reads the same at both ends
 *  of the rail's 280–560px range.
 *
 *  On the shadcn `Button` at `ghost`, with its height pulled down to the rail's 24px rhythm: the
 *  primitive's own `sm` is 32px, and six of those in a row would stretch a live-work section by a third.
 *  `title` rather than a `Tooltip` for the truncated label — the app's Tooltip is a CONTROLLED popover
 *  (see components/ui/shadcn/tooltip.tsx), which would need open state per row in a list that can hold
 *  dozens, while the native attribute is what a truncated cell is for. */
function LiveRow({ label, meta, tone, title, onClick, ariaLabel, muted = false }: {
  label: string;
  meta?: string;
  /** `none` leaves the dot off, for a section whose row already carries a status control of its own — the
   *  Tasks section puts a checkbox there, and a dot beside it would state the same thing twice. */
  tone: 'running' | 'idle' | 'none';
  title?: string;
  onClick?: () => void;
  ariaLabel: string;
  /** Quiets the label for a row that cannot proceed (a task waiting on its blockers). */
  muted?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      // Named, because a live-work section now also holds its Collapsible's trigger button: a test (or a
      // reader) addressing "the button in this section" would otherwise land on the fold, not the row.
      data-testid="telemetry-row"
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel}
      title={title ?? label}
      // `min-w-0 flex-1` rather than `w-full`: the row also carries a fixed-size icon (and, in the other-
      // processes section, a badge and a kill button), so a child asking for the row's FULL width starts
      // every layout pass over budget and only truncation inside it saves the row.
      className="h-6 min-w-0 flex-1 justify-start gap-1.5 rounded px-1 text-left text-xs disabled:cursor-default disabled:opacity-100"
    >
      {tone === 'none' ? null : <span className={`shrink-0 ${tone === 'running' ? 'text-success' : 'text-subtle-foreground'}`} aria-hidden>●</span>}
      <span className={`min-w-0 flex-1 truncate ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{label}</span>
      {meta ? <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{meta}</span> : null}
    </Button>
  );
}

/** The rail's row test ids for the shared `TodoRow`: the names the rail's own tests have always used. */
const RAIL_TASK_ROW_IDS: TodoRowIds = { row: 'telemetry-row', running: 'telemetry-task-running', elapsed: 'telemetry-task-elapsed', blocked: 'telemetry-task-blocked' };

/** The conversation's task list, as the rail reports it: a done/total meter, the work that matters now,
 *  and one menu control per row.
 *
 *  It is the same live-work section as Processes and Agents — same head, same fold — but the rows are
 *  the transcript todo card's own `TodoRow`s, not the section's read-out rows, because this is the one
 *  section whose rows the reader can also CHANGE. A row's menu patches the task; "Open the task list"
 *  leads to the full list, where renaming, ownership and the finished work live. The rows are previewed
 *  to the shared todo cap, so a forty-task plan cannot push the rest of the rail off the screen. */
function TasksSection({ tasks, onStatus, onOpen }: {
  tasks: readonly RailTask[];
  onStatus: (task: RailTask, status: RailTask['status']) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const done = tasks.filter((task) => task.status === 'completed').length;
  const hidden = Math.max(0, tasks.length - TODO_PREVIEW_ITEMS);
  const shown = expanded || hidden === 0 ? tasks : tasks.slice(0, TODO_PREVIEW_ITEMS);
  return (
    <LiveSection
      label={t.telemetry.tasks}
      count={`${done}/${tasks.length}`}
      testId="telemetry-tasks"
      meter={<Progress className="h-1" value={(done / tasks.length) * 100} aria-label={t.telemetry.tasks} />}
      listClassName="flex flex-col"
    >
      {shown.map((task, index) => (
        <TodoRow
          key={task.id ?? `row-${index}`}
          row={task}
          now={now}
          onStatus={onStatus}
          onOpen={onOpen}
          ids={RAIL_TASK_ROW_IDS}
        />
      ))}
      {hidden > 0 ? (
        <li className="pt-0.5">
          <MorePill expanded={expanded} hidden={hidden} onToggle={() => setExpanded((value) => !value)} label={t.telemetry.tasks} />
        </li>
      ) : null}
    </LiveSection>
  );
}

/** The context-fill meter, on the shared `Progress` primitive and the shared pressure ramp, so it and the
 *  subscription windows below it speak one visual language. */
function ContextMeter({ percent, label }: { percent: number; label: string }) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <Progress
      value={pct}
      indicatorValue={usageMeterValue(pct)}
      indicatorClassName={usageProgressClass(pct)}
      aria-label={label}
    />
  );
}

/** The scrolling middle band: everything the reader consults rather than everything that is true.
 *  Context → goal → limits → live work → MCP → LSP, ordered by how often it is looked at rather than by
 *  how it falls out of the API. A section with nothing to report simply does not render — an empty rail
 *  is quieter than a rail full of dashes.
 *
 *  This is the ONE content source: the desktop dock and the mobile overlay both render this component, so
 *  the two hosts differ in geometry only and can never drift apart in what they report. */
function TelemetryBody({ onOpenWorkflow }: { onOpenWorkflow?: (id: string) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { usage, telemetry, activeSessionId, usageProvider, goal, subagents, workflows, cards, setAgentsOpen, setTasksOpen, syncSessionTasks } = useBrainChat();
  const { data: allProcesses = [] } = useBrainProcesses();
  const rail = useTelemetryRail();
  const qc = useQueryClient();
  // Track the open process by id, not a click-time copy, so the modal follows the live list (it stops
  // polling once the process exits, and closes when the process is pruned away).
  const [openProcessId, setOpenProcessId] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState<ProcessInfo | null>(null);
  const killPendingRef = useRef(false);
  // A drill-in session is intentionally not owner-addressable through /brain/rate-limits?session=. Fetch
  // the owner-wide provider map and select with the focused snapshot's provider instead; an empty provider
  // while that snapshot loads must show no rail rather than leaking the parent's account into the child.
  // The map is keyed by pi provider id, so it is `usageProvider` that selects here — the public config id
  // shown everywhere else is a different namespace and would match nothing.
  const { data: limitsByProvider = {} } = useBrainRateLimitsAll();
  const limits = usageProvider ? (limitsByProvider[usageProvider] ?? null) : null;

  const mcp = telemetry.mcp;
  const mcpConnected = mcp?.filter((s) => s.status === 'connected') ?? [];
  // Only LIVE work belongs in the rail — a finished goal, DAG, agent or process lives on in the
  // transcript, and a section listing settled work would push the running one off the screen.
  const activeGoal: BrainGoal | null = goal?.status === 'active' ? goal : null;
  const runningWorkflows = workflows.filter((wf) => wf.status === 'running');
  // A terminal agent whose result the parent has not acknowledged is still live work (CLI parity).
  const liveAgents = subagents.filter((a) => a.status === 'running' || a.resultDelivery === 'pending');
  // A `foreground` handle is an in-flight Bash tool call that MAY still be detached, not a background
  // job — listing it would flash every ordinary shell command through the rail.
  const liveProcesses = allProcesses.filter((p) => p.running && p.completionMode !== 'foreground');
  // The query is owner-wide, and both halves of it matter: this conversation's own live work reads as the
  // rail's, while everything else — another chat, a channel, an orphaned delegate's leftover service —
  // gets its own section below rather than being hidden. Hiding it left no way to kill it from the web.
  const owned = useMemo(() => ownedSessionIds(activeSessionId, subagents), [activeSessionId, subagents]);
  const processes = liveProcesses.filter((p) => isOwnProcess(p, owned));
  const otherProcesses = liveProcesses.filter((p) => !isOwnProcess(p, owned));
  // Resolved across BOTH lists so the output modal follows whichever row opened it.
  const openProcess = liveProcesses.find((p) => p.id === openProcessId) ?? null;
  const killProcess = async (proc: ProcessInfo): Promise<void> => {
    if (killPendingRef.current) return;
    killPendingRef.current = true;
    try {
      const result = await elowenClient.brainKillProcess(proc.id);
      setConfirmKill((current) => current?.id === proc.id ? null : current);
      toast(result.killed ? t.telemetry.processKilled : t.telemetry.processAlreadyFinished);
    } catch {
      toast(t.telemetry.processKillError, 'error');
    } finally {
      try {
        await qc.invalidateQueries({ queryKey: ['brain-processes'] });
      } finally {
        killPendingRef.current = false;
      }
    }
  };
  // The task list, from the TODO card the stream already carries. A card that predates the structured
  // items has rows but no ids, and a row that cannot be addressed cannot be ticked — only then is the
  // plugin's task list fetched, once, as the fallback. A conversation with no todo card asks for nothing.
  const cardRows = useMemo(() => cardTasks(cards), [cards]);
  const addressable = cardTasksAddressable(cardRows);
  const taskFallback = useSessionTasks(cardRows.length > 0 && !addressable ? activeSessionId : null);
  const fallbackTasks = taskFallback.data?.tasks;
  const tasks = useMemo(
    () => orderTasks(addressable ? cardRows : sessionTaskRows(fallbackTasks ?? [])),
    [addressable, cardRows, fallbackTasks],
  );
  // The CardBlock rule, mirrored: a list whose every row is ticked has nothing left to track.
  const showTasks = tasks.length > 0 && tasks.some((task) => task.status !== 'completed');
  const updateTask = useUpdateSessionTask();
  const setTaskStatus = (task: RailTask, status: RailTask['status']): void => {
    if (!activeSessionId || !task.id || status === task.status) return;
    updateTask.mutate(
      { sessionId: activeSessionId, taskId: task.id, status },
      { onSuccess: (result) => syncSessionTasks(result.tasks), onError: (error: Error) => toast(error.message, 'error') },
    );
  };
  // On a phone the rail IS the screen, so the list has to take it rather than open behind the sheet that
  // raised it — the same handover the workflow drill-in makes.
  const openTasks = useCallback((): void => { rail?.setMobileOpen(false); setTasksOpen(true); }, [rail, setTasksOpen]);
  const sections = [
    usage !== null,
    activeGoal !== null,
    !!limits?.windows.length,
    showTasks,
    runningWorkflows.length > 0,
    liveAgents.length > 0,
    processes.length > 0,
    otherProcesses.length > 0,
    mcpConnected.length > 0,
    telemetry.lspEnabled !== null,
  ];
  const goalTurns = activeGoal && activeGoal.turn_budget > 0
    ? `${activeGoal.turns_used}/${activeGoal.turn_budget} ${plural(t.telemetry.goalTurns, activeGoal.turn_budget)}`
    : activeGoal ? `${activeGoal.turns_used} ${plural(t.telemetry.goalTurns, activeGoal.turns_used)}` : undefined;
  const goalElapsed = useGoalElapsed(activeGoal);
  const goalMeta = goalTurns ? `${goalTurns} · ${formatDuration(goalElapsed)}` : undefined;
  const subgoals = activeGoal ? goalSubgoalTally(activeGoal.subgoals) : null;

  if (!sections.some(Boolean)) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">{t.telemetry.empty}</p>;
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-3 py-3 [&_li]:min-w-0">
      {usage ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-context">
          <SectionHead
            label={t.brainChat.context}
            icon={<Gauge size={11} className="shrink-0 text-subtle-foreground" aria-hidden />}
            meta={usage.percent == null ? undefined : <SectionMeta>{Math.round(usage.percent)}%</SectionMeta>}
          />
          <ContextMeter percent={usage.percent ?? 0} label={t.brainChat.context} />
          <p className="font-mono text-xs text-muted-foreground">
            {formatTokens(usage.tokens ?? 0)} / {formatTokens(usage.contextWindow)} · {formatCost(usage.cost, 2)}
          </p>
        </section>
      ) : null}

      {activeGoal ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-goal">
          <SectionHead
            label={t.telemetry.goal}
            icon={<Target size={11} className="shrink-0 text-subtle-foreground" aria-hidden />}
            meta={goalMeta ? <SectionMeta>{goalMeta}</SectionMeta> : undefined}
          />
          <p className="flex items-center gap-1.5 text-xs">
            <Target size={11} className="shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 truncate text-foreground" title={activeGoal.goal}>{activeGoal.goal}</span>
          </p>
          {activeGoal.last_evidence ? (
            <p className="line-clamp-2 text-xs text-muted-foreground" title={activeGoal.last_evidence}>
              {t.telemetry.goalProgress.replace('{text}', activeGoal.last_evidence)}
            </p>
          ) : null}
          {subgoals ? (
            <p className="text-xs text-muted-foreground">
              {t.telemetry.goalSubgoals.replace('{done}', String(subgoals.done)).replace('{total}', String(subgoals.total))}
            </p>
          ) : null}
        </section>
      ) : null}

      {limits?.windows.length ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-limits">
          <SectionHead
            label={t.telemetry.limits}
            icon={<Clock3 size={11} className="shrink-0 text-subtle-foreground" aria-hidden />}
            meta={limits.planType ? <SectionMeta>{limits.planType}</SectionMeta> : undefined}
          />
          <OAuthUsageRail usage={limits} />
        </section>
      ) : null}

      {showTasks ? (
        <TasksSection tasks={tasks} onStatus={setTaskStatus} onOpen={openTasks} />
      ) : null}

      {runningWorkflows.length > 0 ? (
        <LiveSection label={t.telemetry.workflow} count={runningWorkflows.length} testId="telemetry-workflow">
          {runningWorkflows.map((wf) => (
            <li key={wf.id} className="flex items-center gap-1.5">
              <Workflow size={11} className="shrink-0 text-primary" aria-hidden />
              {wf.workspaceRef ? (
                <span className="shrink-0" title={t.agents.sandboxed}>
                  <GitBranch size={10} className="text-subtle-foreground" aria-hidden />
                </span>
              ) : null}
              <LiveRow
                label={workflowLabel(wf)}
                meta={workflowProgress(wf)}
                tone="running"
                ariaLabel={t.telemetry.workflowOpen}
                title={`${workflowLabel(wf)} — ${workflowProgress(wf)} ${t.telemetry.workflowNodes}`}
                {...(onOpenWorkflow ? { onClick: () => onOpenWorkflow(wf.id) } : {})}
              />
            </li>
          ))}
        </LiveSection>
      ) : null}

      {liveAgents.length > 0 ? (
        <LiveSection
          label={t.telemetry.agents}
          count={`${liveAgents.length} ${plural(t.agents.link, liveAgents.length)}`}
          testId="telemetry-agents"
        >
          {liveAgents.map((agent) => (
            <li key={agent.sessionId} className="flex items-center gap-1.5">
              <Users size={11} className="shrink-0 text-subtle-foreground" aria-hidden />
              {agent.workspaceId ? (
                <span className="shrink-0" title={t.agents.sandboxed}>
                  <GitBranch size={10} className="text-subtle-foreground" aria-hidden />
                </span>
              ) : null}
              <LiveRow
                label={agent.detail || agent.task}
                meta={agent.tokens != null ? formatTokens(agent.tokens) : undefined}
                tone={agent.status === 'running' ? 'running' : 'idle'}
                title={agent.task}
                ariaLabel={t.telemetry.agentsOpen}
                onClick={() => setAgentsOpen(true)}
              />
            </li>
          ))}
        </LiveSection>
      ) : null}

      {processes.length > 0 ? (
        <LiveSection
          label={t.telemetry.processes}
          count={`${processes.length} ${plural(t.telemetry.processesCount, processes.length)}`}
          testId="telemetry-processes"
        >
          {processes.map((proc) => (
            <li key={proc.id} className="flex items-center gap-1.5">
              <TerminalSquare size={11} className="shrink-0 text-subtle-foreground" aria-hidden />
              <LiveRow
                label={proc.command}
                tone="running"
                title={proc.command}
                ariaLabel={t.telemetry.processOpen}
                onClick={() => setOpenProcessId(proc.id)}
              />
            </li>
          ))}
        </LiveSection>
      ) : null}

      {/* Everything the open conversation does NOT own: another chat, a channel, or the service an
          orphaned delegate left running. Kept in its own section so the rail above stays this
          conversation's, while the one view able to reach a stranded process still exists. The kill
          button is always visible here (no hover reveal) — the overlay is used on touch, where a
          hover-only control is unreachable, and killing is the whole point of this section. */}
      {otherProcesses.length > 0 ? (
        <LiveSection
          label={t.telemetry.otherProcesses}
          count={`${otherProcesses.length} ${plural(t.telemetry.processesCount, otherProcesses.length)}`}
          testId="telemetry-processes-other"
        >
          {otherProcesses.map((proc) => {
            const origin = processOrigin(proc.sessionId);
            return (
              <li key={proc.id} className="flex items-center gap-1.5">
                <TerminalSquare size={11} className="shrink-0 text-subtle-foreground" aria-hidden />
                <LiveRow
                  label={proc.command}
                  tone="running"
                  title={proc.command}
                  ariaLabel={t.telemetry.processOpen}
                  onClick={() => setOpenProcessId(proc.id)}
                />
                {origin ? (
                  <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]" title={proc.sessionId ?? undefined}>
                    {t.processes[origin]}
                  </Badge>
                ) : null}
                {/* A destructive control sitting directly beside a tappable row needs a finger-sized hit
                    area of its own; the glyph stays small so the row keeps its quiet density. */}
                <Button
                  variant="ghost-destructive"
                  size="icon"
                  onClick={() => setConfirmKill(proc)}
                  aria-label={t.processes.kill}
                  title={t.processes.kill}
                  className="size-7 shrink-0 rounded"
                >
                  <X size={11} aria-hidden />
                </Button>
              </li>
            );
          })}
        </LiveSection>
      ) : null}

      {openProcess ? <ProcessOutputModal proc={openProcess} onClose={() => setOpenProcessId(null)} /> : null}

      <ConfirmDialog
        open={confirmKill !== null}
        title={t.telemetry.processKillTitle}
        description={confirmKill
          ? interpolate(t.telemetry.processKillConfirm, {
            command: confirmKill.command,
            origin: (() => {
              const origin = processOrigin(confirmKill.sessionId);
              return origin ? t.processes[origin] : t.telemetry.processOriginUnknown;
            })(),
          })
          : undefined}
        confirmLabel={t.processes.kill}
        onConfirm={() => confirmKill ? killProcess(confirmKill) : Promise.resolve()}
        onClose={() => { if (!killPendingRef.current) setConfirmKill(null); }}
      />

      {mcpConnected.length > 0 ? (
        <LiveSection
          label={t.telemetry.mcp}
          count={t.telemetry.mcpActive.replace('{active}', String(mcpConnected.length)).replace('{total}', String(mcp?.length ?? 0))}
          testId="telemetry-mcp"
        >
          {mcpConnected.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5 text-xs">
              <span className="shrink-0 text-success" aria-hidden>●</span>
              <span className="min-w-0 truncate font-mono text-foreground" title={s.name}>{s.name}</span>
            </li>
          ))}
        </LiveSection>
      ) : null}

      {telemetry.lspEnabled !== null ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-lsp">
          <SectionHead label={t.telemetry.lsp} icon={<Braces size={11} className="shrink-0 text-subtle-foreground" aria-hidden />} />
          <p className="flex items-center gap-1.5 text-xs">
            <Badge variant={telemetry.lspEnabled ? 'soft-success' : 'secondary'} className="px-1 py-0 text-[10px]">
              {telemetry.lspEnabled ? t.telemetry.lspActive : t.telemetry.lspInactive}
            </Badge>
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** The pinned head: who is here and what they are doing, sitting on the viewport's top edge.
 *
 *  The mascot moved from a ~230px decorative block to a 56px glyph with the status BESIDE it rather than
 *  under it, which is what bought the scrolling band its screen. */
function TelemetryHead({ busy, collapsible, collapsed, onToggle }: {
  busy: boolean;
  collapsible: boolean;
  collapsed: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="telemetry-head" className="flex items-center gap-2 px-3 py-2">
      <TelemetryMascot busy={busy} size={56} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{t.telemetry.title}</span>
        <Badge variant={busy ? 'soft-primary' : 'secondary'} className="w-fit px-1 py-0 text-[10px]">
          {busy ? t.telemetry.statusRunning : t.telemetry.statusIdle}
        </Badge>
      </div>
      {collapsible && onToggle ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label={collapsed ? t.telemetry.expand : t.telemetry.collapse}
          title={collapsed ? t.telemetry.expand : t.telemetry.collapse}
          aria-expanded={!collapsed}
          className="size-7 shrink-0 rounded"
          data-testid="telemetry-collapse"
        >
          {collapsed ? <PanelRightOpen size={14} aria-hidden /> : <PanelRightClose size={14} aria-hidden />}
        </Button>
      ) : null}
    </div>
  );
}

/** The pinned foot: which workspace this conversation is standing in, on the viewport's bottom edge.
 *  Workspace identity is ambient information — it belongs on a status bar, not in the middle of the
 *  metrics it never changes with. */
function TelemetryFoot() {
  const { t } = useTranslation();
  const { telemetry } = useBrainChat();
  const project = telemetry.project;
  const workspace = project?.workspace ?? null;
  if (!project?.cwd && !project?.branch) return null;
  return (
    <div data-testid="telemetry-foot" className="flex flex-col gap-0.5 px-3 py-2">
      <section className="flex flex-col gap-0.5" data-testid="telemetry-project">
        {workspace ? (
          // A bound Sandbox workspace means the next turn starts in the worktree, where shell commands run
          // in its container rather than on the host; the directory below stays the client's own. Said
          // once, calmly, with the explanation and the way out behind the shared help affordance.
          <p className="flex min-w-0 items-center gap-1 text-xs" data-testid="telemetry-workspace">
            <Badge variant="outline" className="min-w-0 max-w-full gap-1 px-1 py-0 font-mono text-[10px]">
              <span className="shrink-0">{t.telemetry.workspaceBadge}</span>
              <span className="shrink-0 text-subtle-foreground" aria-hidden>·</span>
              <span className="min-w-0 truncate" title={workspace.label}>{workspace.label}</span>
            </Badge>
            <HelpTip align="left">{interpolate(t.telemetry.workspaceHelp, { label: workspace.label, branch: workspace.branch, path: workspace.path })}</HelpTip>
          </p>
        ) : null}
        {project?.cwd ? (
          <p className="truncate font-mono text-xs text-foreground" title={project.cwd}>{project.cwd}</p>
        ) : null}
        {project?.branch ? (
          // A branch name is one unbreakable token (`agent/chat-rail-no-scroll-20260818`), so without a
          // truncation of its own it sets the section's minimum width — the same rule the cwd above
          // already follows.
          <p className="flex items-baseline gap-1 font-mono text-xs text-muted-foreground">
            <GitBranch size={10} className="shrink-0 text-subtle-foreground" aria-hidden />
            <span className="shrink-0">{t.telemetry.branch}</span>
            <span className="min-w-0 truncate text-primary" title={project.branch}>{project.branch}</span>
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** One instrument in the compact rail. It keeps the 52px strip readable without inventing a second
 *  dashboard: icon = section identity, optional micro-meter = pressure, mono value = the one number worth
 *  seeing without expanding. Every instrument opens the full rail for detail; native title carries the
 *  complete label for mouse users while `aria-label` names the same action to assistive tech. */
function CompactTelemetryItem({ id, icon: Icon, label, value, progress, tone = 'muted', onOpen }: {
  id: string;
  icon: LucideIcon;
  label: string;
  value?: string;
  progress?: number;
  tone?: 'muted' | 'primary' | 'success' | 'warning';
  onOpen?: () => void;
}) {
  const title = value ? `${label}: ${value}` : label;
  const content = (
    <>
      <Icon
        size={14}
        className={tone === 'primary' ? 'text-primary' : tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-subtle-foreground'}
        aria-hidden
      />
      {progress != null ? (
        <Progress
          className="h-1 w-7"
          value={Math.max(0, Math.min(100, progress))}
          indicatorValue={usageMeterValue(progress)}
          indicatorClassName={usageProgressClass(progress)}
          aria-hidden
        />
      ) : null}
      {value ? <span className="max-w-full truncate font-mono text-[9px] leading-none tabular-nums text-muted-foreground">{value}</span> : null}
    </>
  );
  const className = "flex h-auto w-10 flex-col items-center gap-1 rounded-md px-1 py-1.5";
  if (!onOpen) {
    return <div data-testid={`telemetry-compact-${id}`} className={className} title={title}>{content}</div>;
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={`telemetry-compact-${id}`}
      onClick={onOpen}
      aria-label={title}
      title={title}
      className={className}
    >
      {content}
    </Button>
  );
}

/** The collapsed 52px instrument strip. It mirrors every section that can appear in the expanded body:
 *  context, subscription windows, active goal/work, processes, MCP, LSP and project identity. Sections
 *  without data stay absent exactly as they do in the full rail. The middle is independently scrollable,
 *  so even a short desktop can reach every instrument without widening the conversation gutter. */
function TelemetryStub({ busy, onToggle }: { busy: boolean; onToggle?: () => void }) {
  const { t } = useTranslation();
  const { usage, telemetry, activeSessionId, usageProvider, goal, subagents, workflows, cards } = useBrainChat();
  const { data: limitsByProvider = {} } = useBrainRateLimitsAll();
  const { data: allProcesses = [] } = useBrainProcesses();
  // The strip reads the cards directly and never falls back to a fetch: a card with no structured ids
  // still has rows to count, and counting is all an instrument does.
  const tasks = useMemo(() => cardTasks(cards), [cards]);
  const doneTasks = tasks.filter((task) => task.status === 'completed').length;
  const limits = usageProvider ? (limitsByProvider[usageProvider] ?? null) : null;
  const activeGoal = goal?.status === 'active' ? goal : null;
  const liveAgents = subagents.filter((agent) => agent.status === 'running' || agent.resultDelivery === 'pending');
  const runningWorkflows = workflows.filter((workflow) => workflow.status === 'running');
  const owned = ownedSessionIds(activeSessionId, subagents);
  const liveProcesses = allProcesses.filter((process) => process.running && process.completionMode !== 'foreground');
  const ownProcesses = liveProcesses.filter((process) => isOwnProcess(process, owned));
  const otherProcesses = liveProcesses.filter((process) => !isOwnProcess(process, owned));
  const connectedMcp = telemetry.mcp?.filter((server) => server.status === 'connected') ?? [];
  const projectTitle = [telemetry.project?.cwd, telemetry.project?.branch].filter(Boolean).join(' · ');
  const contextPct = Math.max(0, Math.min(100, usage?.percent ?? 0));

  return (
    <div data-testid="telemetry-stub" className="flex h-full min-h-0 flex-col items-center bg-background py-2">
      {onToggle ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label={t.telemetry.expand}
          title={t.telemetry.expand}
          aria-expanded={false}
          className="size-8 shrink-0 rounded"
          data-testid="telemetry-collapse"
        >
          <PanelRightOpen size={14} aria-hidden />
        </Button>
      ) : null}
      <div className="mt-2 shrink-0">
        <TelemetryMascot busy={busy} size={32} />
      </div>
      <Separator className="my-2 w-7 shrink-0" />
      <ScrollArea
        data-testid="telemetry-compact-scroll"
        className="min-h-0 w-full flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden"
        type="scroll"
      >
        <div className="flex w-full flex-col items-center gap-1 pb-2">
          {usage ? (
            <CompactTelemetryItem
              id="context"
              icon={Gauge}
              label={t.brainChat.context}
              value={`${Math.round(contextPct)}%`}
              progress={contextPct}
              onOpen={onToggle}
            />
          ) : null}
          {limits?.windows.map((window, index) => {
            const pct = Math.max(0, Math.min(100, window.usedPercent));
            const windowName = usageWindowLabel(window.windowMinutes, t.brain.usageWeekly, t.brain.usageWindow);
            return (
              <CompactTelemetryItem
                key={`${window.windowMinutes ?? 'window'}-${index}`}
                id={`limit-${index}`}
                icon={Clock3}
                label={`${t.telemetry.limits} · ${windowName}`}
                value={`${Math.round(pct)}%`}
                progress={pct}
                onOpen={onToggle}
              />
            );
          })}
          {activeGoal ? (
            <CompactTelemetryItem
              id="goal"
              icon={Target}
              label={activeGoal.goal}
              value={activeGoal.turn_budget > 0 ? `${activeGoal.turns_used}/${activeGoal.turn_budget}` : String(activeGoal.turns_used)}
              tone="primary"
              onOpen={onToggle}
            />
          ) : null}
          {doneTasks < tasks.length ? (
            <CompactTelemetryItem
              id="tasks"
              icon={ListChecks}
              label={t.telemetry.tasks}
              value={`${doneTasks}/${tasks.length}`}
              progress={(doneTasks / tasks.length) * 100}
              tone="primary"
              onOpen={onToggle}
            />
          ) : null}
          {runningWorkflows.length > 0 ? (
            <CompactTelemetryItem id="workflows" icon={Workflow} label={t.telemetry.workflow} value={String(runningWorkflows.length)} tone="primary" onOpen={onToggle} />
          ) : null}
          {liveAgents.length > 0 ? (
            <CompactTelemetryItem id="agents" icon={Users} label={t.telemetry.agents} value={String(liveAgents.length)} tone="success" onOpen={onToggle} />
          ) : null}
          {ownProcesses.length > 0 ? (
            <CompactTelemetryItem id="processes" icon={TerminalSquare} label={t.telemetry.processes} value={String(ownProcesses.length)} tone="success" onOpen={onToggle} />
          ) : null}
          {otherProcesses.length > 0 ? (
            <CompactTelemetryItem id="other-processes" icon={TerminalSquare} label={t.telemetry.otherProcesses} value={String(otherProcesses.length)} tone="warning" onOpen={onToggle} />
          ) : null}
          {connectedMcp.length > 0 ? (
            <CompactTelemetryItem
              id="mcp"
              icon={Server}
              label={t.telemetry.mcp}
              value={`${connectedMcp.length}/${telemetry.mcp?.length ?? 0}`}
              tone="success"
              onOpen={onToggle}
            />
          ) : null}
          {telemetry.lspEnabled !== null ? (
            <CompactTelemetryItem
              id="lsp"
              icon={Braces}
              label={`${t.telemetry.lsp}: ${telemetry.lspEnabled ? t.telemetry.lspActive : t.telemetry.lspInactive}`}
              value={telemetry.lspEnabled ? '●' : '○'}
              tone={telemetry.lspEnabled ? 'success' : 'muted'}
              onOpen={onToggle}
            />
          ) : null}
        </div>
      </ScrollArea>
      {projectTitle ? (
        <>
          <Separator className="my-2 w-7 shrink-0" />
          <CompactTelemetryItem id="project" icon={GitBranch} label={projectTitle} tone="primary" onOpen={onToggle} />
        </>
      ) : null}
    </div>
  );
}

/** Head, body and foot as one continuous band, separated by hairlines rather than by card edges.
 *
 *  The head and the foot are pinned and the middle is the only thing that scrolls, which is what lets the
 *  rail sit flush on all three viewport edges: there is no outer scroller to clip it and no frame inset
 *  to keep it off the glass. */
function TelemetryRailContent({ busy, collapsible, onToggle, onOpenWorkflow }: {
  busy: boolean;
  collapsible: boolean;
  onToggle?: () => void;
  onOpenWorkflow?: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TelemetryHead busy={busy} collapsible={collapsible} collapsed={false} onToggle={onToggle} />
      <Separator />
      <ScrollArea data-testid="telemetry-scroll" className="min-h-0 flex-1" type="hover">
        <TelemetryBody onOpenWorkflow={onOpenWorkflow} />
      </ScrollArea>
      <Separator />
      <TelemetryFoot />
    </div>
  );
}

/** The phone slide-over, on the shadcn `Dialog` (Radix): the dialog role, the focus trap, Escape and the
 *  layer order among several open overlays are Radix's, so this file no longer writes any of them.
 *
 *  Like the history drawer it does NOT take `useOverlayIsolation`: that stack isolates the background by
 *  marking every OTHER child of <body> inert, which needs an overlay portalled to the body, and this one
 *  renders inside the chat shell — its own body-level ancestor is what would be marked, so the drawer
 *  would disable itself. Radix's `aria-hidden` sweep walks the ancestor chain instead. What the stack
 *  still owns and Radix cannot is where focus goes on the way out: there is no `Dialog.Trigger` to hand
 *  it back to. */
function TelemetryDrawer({ label, onClose, children }: { label: string; onClose?: () => void; children: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { restoreFocus } = useReturnFocus();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <div
        className="overlay-layer-drawer fixed inset-0"
        // Radix's modal content sets `pointer-events: none` on <body> and re-enables them on itself;
        // this layer would inherit the block and the backdrop below would stop answering the click that
        // dismisses the drawer. Opting back in is what `DialogOverlay` does for the same reason.
        style={{ pointerEvents: 'auto' }}
      >
        <div className="absolute inset-0 bg-background/50" onClick={onClose} aria-hidden />
        <DialogContent
          ref={surfaceRef}
          // A right rail that owns its own internal scrolling, which none of the primitive's presentations
          // describes; the geometry stays here. Only the geometry: `presentation={null}` drops the shape
          // classes, but `.overlay-surface` is in the variant BASE and still paints the ground, the
          // border colour and the raised shadow.
          presentation={null}
          aria-label={label}
          aria-describedby={undefined}
          data-testid="telemetry-drawer"
          // Full-bleed on a phone rather than a 18rem sliver: the same three-zone rail, given the whole
          // screen instead of being squeezed into the margin of a conversation it is covering anyway.
          className="animate-drawer-in absolute inset-y-0 right-0 flex w-full flex-col overflow-hidden border-l border-border sm:max-w-sm"
          // The backdrop above already owns dismissal, and it is the only owner that knows a nested
          // overlay's backdrop must not close its parent — the rail raises both a process modal and the
          // command field from inside itself.
          onInteractOutside={(event) => event.preventDefault()}
          // The panel is something to read, so focus anchors on the surface rather than on the close
          // button Radix would pick; the opener gets it back on the way out.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (surfaceRef.current) focusOverlaySurface(surfaceRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          {children}
        </DialogContent>
      </div>
    </Dialog>
  );
}

/** The chat telemetry rail — the web counterpart of the CLI's right-hand panel. It holds information
 *  rather than asking for attention: quiet labels, one meter vocabulary, no colour unless a number is
 *  under pressure.
 *
 *  `column` is the desktop dock and `drawer` is the phone overlay. NEITHER owns its width any more: the
 *  dock is a `ResizablePanel` in the shell (see components/shell/Shell.tsx), which is what lets it sit
 *  flush against the top, right and bottom edges of the viewport instead of starting below the chat
 *  header. This component fills whatever box its host gives it, so the same content works in a 52px stub,
 *  a 340px dock and a full-screen sheet. */
export function TelemetryPanel({ variant, open = false, collapsed = false, onClose, onToggleCollapsed, onOpenWorkflow }: {
  variant: 'column' | 'drawer';
  open?: boolean;
  /** Desktop only: render the 52px stub instead of the full rail. */
  collapsed?: boolean;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
  /** Open the navigable DAG view for a workflow row. Absent → the rows are inert (they still report the
   *  running DAGs), so the rail never depends on a host that has no such view to show. */
  onOpenWorkflow?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { busy } = useBrainChat();

  if (variant === 'drawer') {
    // Mounted only while open, like the history drawer: a closed drawer leaves nothing focusable behind.
    if (!open) return null;
    return (
      <TelemetryDrawer label={t.telemetry.title} onClose={onClose}>
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t.telemetry.title}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t.telemetry.close}
            title={t.telemetry.close}
            className="size-9 shrink-0"
          >
            <X size={16} aria-hidden />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <TelemetryRailContent busy={busy} collapsible={false} onOpenWorkflow={onOpenWorkflow} />
        </div>
      </TelemetryDrawer>
    );
  }

  return (
    <aside
      aria-label={t.telemetry.title}
      data-testid="telemetry-column"
      data-collapsed={collapsed || undefined}
      // The panel that hosts this owns the width; `w-full` makes the rail consume it instead of shrink-
      // wrapping its contents and leaving an empty strip at the viewport edge. The only painted edge is the
      // resize handle on the left.
      className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-background"
    >
      {collapsed
        ? <TelemetryStub busy={busy} onToggle={onToggleCollapsed} />
        : <TelemetryRailContent busy={busy} collapsible onToggle={onToggleCollapsed} onOpenWorkflow={onOpenWorkflow} />}
    </aside>
  );
}
