'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Target, TerminalSquare, Users, Workflow, X } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { plural } from '../../lib/i18n/plural';
import { elowenClient } from '../../lib/elowenClient';
import { useBrainProcesses, useBrainRateLimitsAll } from '../../lib/queries';
import { formatTokens, formatCost } from '../../lib/format';
import { OAuthUsageRail, usageFillClass } from '../settings/OAuthUsageRail';
import { MascotGlyph } from '../../components/ui/SpatialMascot';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import { Dialog, DialogContent } from '../../components/ui/shadcn/dialog';
import { focusOverlaySurface, useReturnFocus } from '../../components/ui/overlayStack';
import { railTypeVars, useTelemetryRailWidth, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH } from '../../lib/useTelemetryRailWidth';
import { workflowLabel, workflowProgress } from '../../lib/workflowDag';
import { useBrainChat } from './BrainChatProvider';
import { ProcessOutputModal } from './ProcessPanel';
import { ownedSessionIds, isOwnProcess, processOrigin } from '../../lib/processScope';
import { CommandOrbit } from './CommandOrbit';
import type { BrainGoal } from '../../lib/types';

/** The owl presides over the rail the way it tops the CLI panel — and it is not decoration: it mirrors
 *  the agent, breathing while a turn runs and settling when it does not, so the rail reads as inhabited
 *  rather than a dashboard. Kept inside the shared body so the desktop column and the mobile drawer show
 *  the same living header.
 *
 *  It is also the door to the command field: clicking it opens the orbital field of slash commands as an
 *  overlay. An overlay rather than the rail itself — an orbit needs roughly 26rem before its pods start
 *  colliding with the core, which even the widest rail does not reach.
 *
 *  The flat glyph rather than the full WebGL mascot: that scene frames itself at a fixed pixel size, so a
 *  rail this narrow would crop it down to a pair of eyes. */
function TelemetryMascot({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const [fieldOpen, setFieldOpen] = useState(false);
  const mascotRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Closing returns focus to the mascot explicitly. The overlay restores whatever was focused when it
  // opened, which is the mascot only when it was opened by an actual click — a pointer tap leaves focus on
  // the body on some browsers, and the user would land back at the top of the document.
  useEffect(() => {
    if (wasOpen.current && !fieldOpen) mascotRef.current?.focus();
    wasOpen.current = fieldOpen;
  }, [fieldOpen]);
  return (
    <div className="flex justify-center pt-2">
      <button
        ref={mascotRef}
        type="button"
        data-testid="telemetry-mascot"
        aria-label={t.brainChat.commandField.open}
        title={t.brainChat.commandField.open}
        aria-haspopup="dialog"
        aria-expanded={fieldOpen}
        onClick={() => setFieldOpen(true)}
        // Sized as a share of the rail rather than a fixed size: the column is draggable from 15rem to
        // 35rem, and a mascot frozen at one size looks lost in a wide rail and crowds a narrow one. The
        // glyph itself has no intrinsic size (it fills its parent), so the square has to come from here.
        // The floor is deliberately NOT in proportion to the share: at the narrowest rail the percentage
        // already yields less than the floor would, so raising it would push the mascot wider than the
        // column that has to hold it.
        className="aspect-square w-[84%] min-w-[8rem] max-w-[22rem] rounded-full transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
      >
        <MascotGlyph state={busy ? 'saving' : 'idle'} />
      </button>
      {fieldOpen ? <CommandOrbit onClose={() => setFieldOpen(false)} /> : null}
    </div>
  );
}

/** The scroll box both variants put around the shared body.
 *
 *  BOTH axes are declared on purpose. `overflow-y: auto` alone is not "scrolls vertically": CSS computes
 *  the other axis from `visible` to `auto` as soon as one axis is not visible, so the rail answered every
 *  child that could not shrink to the current width with a horizontal scrollbar across the whole column —
 *  and the vertical bar a new section brought in narrowed the content box further, which is why adding a
 *  sub-agent was the usual trigger. The horizontal axis is clipped instead: every row below truncates, so
 *  there is nothing to reach sideways, while the vertical axis stays a real scroller for a long rail.
 *
 *  `.telemetry-rail-scroll` (components.css) then hides the bar VISUALLY only — the box still scrolls by
 *  wheel, touch, keyboard and scroll-into-view, and an 8px bar drawn permanently down a 240px companion
 *  column is exactly the noise this rail exists not to add. It is a design-system class rather than a
 *  Tailwind arbitrary utility because base.css styles `*` scrollbars outside any cascade layer, which
 *  beats @layer utilities regardless of specificity. */
const RAIL_SCROLL = 'telemetry-rail-scroll overflow-y-auto overflow-x-hidden';

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
        <div className="absolute inset-0 bg-bg/50" onClick={onClose} aria-hidden />
        <DialogContent
          ref={surfaceRef}
          // A right rail that is also its own scroll box, which none of the primitive's presentations
          // describes; the geometry stays here.
          presentation={null}
          aria-label={label}
          aria-describedby={undefined}
          data-testid="telemetry-drawer"
          className={`animate-drawer-in absolute inset-y-0 right-0 w-72 max-w-[85%] border-l border-border bg-surface shadow-xl ${RAIL_SCROLL}`}
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

/** A section heading: a quiet label with an optional right-aligned meta value, mirroring the CLI rail. */
function SectionHead({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="telemetry-section-head flex items-baseline justify-between gap-2 text-tiny uppercase tracking-wide text-text-subtle">
      {/* The label truncates like the meta does: it is a translated string, and at the narrow end of the
          rail an uppercase heading like "OTHER PROCESSES" is otherwise a width floor the row cannot go
          under, pushing the whole section past the column. */}
      <span className="min-w-0 truncate">{label}</span>
      {meta ? <span className="truncate font-mono normal-case tracking-normal">{meta}</span> : null}
    </div>
  );
}

/** The context-fill meter. Same pressure colours and same "never read as empty" sliver as the OAuth
 *  limit windows, so both meters in the panel speak one visual language. */
function ContextMeter({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-elevated">
      <span
        className={`block h-full rounded-full ${usageFillClass(pct)} transition-[width] duration-500`}
        style={{ width: `${pct > 0 ? Math.max(pct, 3) : 0}%` }}
      />
    </span>
  );
}

/** One clickable row of a live-work section: a status dot, a truncated label and an optional right-hand
 *  meta column. The label truncates rather than reserving a width, so the row reads the same at both ends
 *  of the rail's 240–560px range. */
function LiveRow({ label, meta, tone, title, onClick, ariaLabel }: {
  label: string;
  meta?: string;
  tone: 'running' | 'idle';
  title?: string;
  onClick?: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel}
      title={title ?? label}
      // `min-w-0 flex-1` rather than `w-full`: the row also carries a fixed-size icon (and, in the other-
      // processes section, a badge and a kill button), so a child asking for the row's FULL width starts
      // every layout pass over budget and only truncation inside it saves the row.
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-tiny transition-colors hover:text-text disabled:cursor-default"
    >
      <span className={`shrink-0 ${tone === 'running' ? 'text-success' : 'text-text-subtle'}`} aria-hidden>●</span>
      <span className="min-w-0 flex-1 truncate text-text">{label}</span>
      {meta ? <span className="shrink-0 font-mono tabular-nums text-text-muted">{meta}</span> : null}
    </button>
  );
}

/** Completed vs. total subgoals of a goal's stored JSON array, or null when it holds none. Malformed
 *  legacy rows are simply omitted — the goal itself still renders. */
function subgoalTally(raw: string): { done: number; total: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const done = parsed.filter((entry): entry is { done: boolean } =>
      typeof entry === 'object' && entry !== null && (entry as { done?: unknown }).done === true).length;
    return { done, total: parsed.length };
  } catch {
    return null;
  }
}

/** The panel's sections, in the CLI rail's order: context fill, goal, subscription limits, workflows,
 *  sub-agents, processes, project, MCP, LSP. A section with nothing to report simply does not render — an
 *  empty rail is quieter than a rail full of dashes. Shared by the desktop column and the mobile drawer. */
function TelemetryBody({ onOpenWorkflow }: { onOpenWorkflow?: (id: string) => void }) {
  const { t } = useTranslation();
  const { usage, telemetry, activeSessionId, provider, busy, goal, subagents, workflows, setAgentsOpen } = useBrainChat();
  const { data: allProcesses = [] } = useBrainProcesses();
  const qc = useQueryClient();
  // Track the open process by id, not a click-time copy, so the modal follows the live list (it stops
  // polling once the process exits, and closes when the process is pruned away).
  const [openProcessId, setOpenProcessId] = useState<string | null>(null);
  // A drill-in session is intentionally not owner-addressable through /brain/rate-limits?session=. Fetch
  // the owner-wide provider map and select with the focused snapshot's provider instead; an empty provider
  // while that snapshot loads must show no rail rather than leaking the parent's account into the child.
  const { data: limitsByProvider = {} } = useBrainRateLimitsAll();
  const limits = provider ? (limitsByProvider[provider] ?? null) : null;

  const project = telemetry.project;
  const mcp = telemetry.mcp;
  const mcpConnected = mcp?.filter((s) => s.status === 'connected') ?? [];
  const hasProject = !!project?.cwd || !!project?.branch;
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
  const killProcess = async (id: string) => {
    await elowenClient.brainKillProcess(id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['brain-processes'] });
  };
  const sections = [
    usage !== null,
    activeGoal !== null,
    !!limits?.windows.length,
    runningWorkflows.length > 0,
    liveAgents.length > 0,
    processes.length > 0,
    otherProcesses.length > 0,
    hasProject,
    mcpConnected.length > 0,
    telemetry.lspEnabled !== null,
  ];
  const goalTurns = activeGoal && activeGoal.turn_budget > 0
    ? `${activeGoal.turns_used}/${activeGoal.turn_budget} ${plural(t.telemetry.goalTurns, activeGoal.turn_budget)}`
    : activeGoal ? `${activeGoal.turns_used} ${plural(t.telemetry.goalTurns, activeGoal.turns_used)}` : undefined;
  const subgoals = activeGoal ? subgoalTally(activeGoal.subgoals) : null;

  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      <TelemetryMascot busy={busy} />
      {!sections.some(Boolean) ? (
        <p className="text-xs text-text-muted">{t.telemetry.empty}</p>
      ) : (
        <>
      {usage ? (
        <section className="flex flex-col gap-1.5" data-testid="telemetry-context">
          <SectionHead
            label={t.brainChat.context}
            meta={usage.percent == null ? undefined : `${Math.round(usage.percent)}%`}
          />
          <ContextMeter percent={usage.percent ?? 0} />
          <p className="font-mono text-tiny text-text-muted">
            {formatTokens(usage.tokens ?? 0)} / {formatTokens(usage.contextWindow)} · {formatCost(usage.cost, 2)}
          </p>
        </section>
      ) : null}

      {activeGoal ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-goal">
          <SectionHead label={t.telemetry.goal} meta={goalTurns} />
          <p className="flex items-center gap-1.5 text-tiny">
            <Target size={11} className="shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 truncate text-text" title={activeGoal.goal}>{activeGoal.goal}</span>
          </p>
          {subgoals ? (
            <p className="text-tiny text-text-muted">
              {t.telemetry.goalSubgoals.replace('{done}', String(subgoals.done)).replace('{total}', String(subgoals.total))}
            </p>
          ) : null}
        </section>
      ) : null}

      {limits?.windows.length ? (
        <section className="flex flex-col gap-1.5" data-testid="telemetry-limits">
          <SectionHead label={t.telemetry.limits} meta={limits.planType ?? undefined} />
          <OAuthUsageRail usage={limits} />
        </section>
      ) : null}

      {runningWorkflows.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-workflow">
          <SectionHead label={t.telemetry.workflow} meta={String(runningWorkflows.length)} />
          <ul className="flex flex-col gap-0.5">
            {runningWorkflows.map((wf) => (
              <li key={wf.id} className="flex items-center gap-1.5">
                <Workflow size={11} className="shrink-0 text-primary" aria-hidden />
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
          </ul>
        </section>
      ) : null}

      {liveAgents.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-agents">
          <SectionHead label={t.telemetry.agents} meta={`${liveAgents.length} ${plural(t.agents.link, liveAgents.length)}`} />
          <ul className="flex flex-col gap-0.5">
            {liveAgents.map((agent) => (
              <li key={agent.sessionId} className="flex items-center gap-1.5">
                <Users size={11} className="shrink-0 text-text-subtle" aria-hidden />
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
          </ul>
        </section>
      ) : null}

      {processes.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-processes">
          <SectionHead label={t.telemetry.processes} meta={`${processes.length} ${plural(t.telemetry.processesCount, processes.length)}`} />
          <ul className="flex flex-col gap-0.5">
            {processes.map((proc) => (
              <li key={proc.id} className="flex items-center gap-1.5">
                <TerminalSquare size={11} className="shrink-0 text-text-subtle" aria-hidden />
                <LiveRow
                  label={proc.command}
                  tone="running"
                  title={proc.command}
                  ariaLabel={t.telemetry.processOpen}
                  onClick={() => setOpenProcessId(proc.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Everything the open conversation does NOT own: another chat, a channel, or the service an
          orphaned delegate left running. Kept in its own section so the rail above stays this
          conversation's, while the one view able to reach a stranded process still exists. The kill
          button is always visible here (no hover reveal) — the drawer is used on touch, where a
          hover-only control is unreachable, and killing is the whole point of this section. */}
      {otherProcesses.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-processes-other">
          <SectionHead
            label={t.telemetry.otherProcesses}
            meta={`${otherProcesses.length} ${plural(t.telemetry.processesCount, otherProcesses.length)}`}
          />
          <ul className="flex flex-col gap-0.5">
            {otherProcesses.map((proc) => {
              const origin = processOrigin(proc.sessionId);
              return (
                <li key={proc.id} className="flex items-center gap-1.5">
                  <TerminalSquare size={11} className="shrink-0 text-text-subtle" aria-hidden />
                  <LiveRow
                    label={proc.command}
                    tone="running"
                    title={proc.command}
                    ariaLabel={t.telemetry.processOpen}
                    onClick={() => setOpenProcessId(proc.id)}
                  />
                  {origin ? (
                    <span className="shrink-0 rounded bg-bg px-1 text-[10px] text-text-muted" title={proc.sessionId ?? undefined}>
                      {t.processes[origin]}
                    </span>
                  ) : null}
                  {/* A destructive control sitting directly beside a tappable row needs a finger-sized hit
                      area of its own; the glyph stays small so the row keeps its quiet density. */}
                  <button
                    type="button"
                    onClick={() => void killProcess(proc.id)}
                    aria-label={t.processes.kill}
                    title={t.processes.kill}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-subtle transition-colors hover:text-danger"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {openProcess ? <ProcessOutputModal proc={openProcess} onClose={() => setOpenProcessId(null)} /> : null}

      {hasProject ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-project">
          <SectionHead label={t.telemetry.project} />
          {project?.cwd ? (
            <p className="truncate font-mono text-tiny text-text" title={project.cwd}>{project.cwd}</p>
          ) : null}
          {project?.branch ? (
            // A branch name is one unbreakable token (`agent/chat-rail-no-scroll-20260818`), so without a
            // truncation of its own it sets the section's minimum width — the same rule the cwd above
            // already follows.
            <p className="flex items-baseline gap-1 font-mono text-tiny text-text-muted">
              <span className="shrink-0">{t.telemetry.branch}</span>
              <span className="min-w-0 truncate text-primary" title={project.branch}>{project.branch}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      {mcpConnected.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-mcp">
          <SectionHead
            label={t.telemetry.mcp}
            meta={t.telemetry.mcpActive.replace('{active}', String(mcpConnected.length)).replace('{total}', String(mcp?.length ?? 0))}
          />
          <ul className="flex flex-col gap-0.5">
            {mcpConnected.map((s) => (
              <li key={s.name} className="flex items-center gap-1.5 text-tiny">
                <span className="shrink-0 text-success" aria-hidden>●</span>
                <span className="truncate font-mono text-text" title={s.name}>{s.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {telemetry.lspEnabled !== null ? (
        <section className="flex flex-col gap-1" data-testid="telemetry-lsp">
          <SectionHead label={t.telemetry.lsp} />
          <p className="flex items-center gap-1.5 text-tiny">
            <span className={`shrink-0 ${telemetry.lspEnabled ? 'text-success' : 'text-text-subtle'}`} aria-hidden>●</span>
            <span className="text-text">{telemetry.lspEnabled ? t.telemetry.lspActive : t.telemetry.lspInactive}</span>
          </p>
        </section>
      ) : null}
        </>
      )}
    </div>
  );
}

/** The chat telemetry rail — the web counterpart of the CLI's right-hand panel. It holds information
 *  rather than asking for attention: quiet labels, one meter vocabulary, no colour unless a number is
 *  under pressure.
 *
 *  `column` is the desktop layout (a real sidebar beside the transcript); `drawer` is the mobile one,
 *  because a second column on a phone would squeeze the conversation off the screen. The host picks
 *  between them via `useMobileViewport()` — this component never renders both, and neither is mounted
 *  until the viewport has actually been measured.
 *
 *  Only the column is resizable, and the variant is the viewport decision: the host already made it, so
 *  the drag handle needs no media query of its own. A phone drawer has nothing to widen into anyway, and
 *  an edge that swallowed horizontal drags would fight the gesture that closes it. */
export function TelemetryPanel({ variant, open = false, onClose, onOpenWorkflow }: {
  variant: 'column' | 'drawer';
  open?: boolean;
  onClose?: () => void;
  /** Open the navigable DAG view for a workflow row. Absent → the rows are inert (they still report the
   *  running DAGs), so the rail never depends on a host that has no such view to show. */
  onOpenWorkflow?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { width, resizeBy, reset } = useTelemetryRailWidth();

  if (variant === 'drawer') {
    // Mounted only while open, like the history drawer: a closed drawer leaves nothing focusable behind.
    if (!open) return null;
    return (
      <TelemetryDrawer label={t.telemetry.title} onClose={onClose}>
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{t.telemetry.title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.telemetry.close}
            title={t.telemetry.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <TelemetryBody onOpenWorkflow={onOpenWorkflow} />
      </TelemetryDrawer>
    );
  }

  return (
    <aside
      aria-label={t.telemetry.title}
      data-testid="telemetry-column"
      style={{ width, ...railTypeVars(width) }}
      className="relative flex shrink-0 flex-col border-l border-border"
    >
      {/* The handle sits ON the column's own border rather than between the two flex children, so
          widening the rail never shifts the divider out from under the cursor mid-drag. */}
      <ResizeHandle
        orientation="vertical"
        onDelta={(dx) => resizeBy(-dx)}
        onReset={reset}
        label={t.telemetry.resize}
        value={width}
        min={RAIL_MIN_WIDTH}
        max={RAIL_MAX_WIDTH}
        className="absolute inset-y-0 left-0 z-10"
      />
      {/* The border runs the full column height while the content itself follows the reader, so the rail
          stays legible through a long transcript instead of scrolling away with the first turns. */}
      <div data-testid="telemetry-scroll" className={`sticky top-0 max-h-[100dvh] ${RAIL_SCROLL}`}>
        <TelemetryBody onOpenWorkflow={onOpenWorkflow} />
      </div>
    </aside>
  );
}
