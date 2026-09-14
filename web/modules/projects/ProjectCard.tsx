'use client';
/** One project of the register, as a card.
 *
 *  The register used to be a table, and the table was losing the argument. A project is not a row of
 *  comparable fields: it is an identity (a mark, a name, what it is for), a runtime (where it executes and
 *  what it is doing right now), a measurement (what it is using), a repository and a team. Five different
 *  kinds of thing, of which a table can only align the two that happen to be short. The Path column had
 *  already been withdrawn for exactly that reason, and the resource meters had to be rendered twice —
 *  once in the wide Resources column, once folded back into the identity cell for narrow shells — because
 *  there was no single place in a row where they belonged.
 *
 *  The card keeps every one of those facts and stops competing for one horizontal budget. What it must NOT
 *  do is become a dashboard tile: the figures on it are operational, the reader is looking for the one
 *  project that is misbehaving, and the whole grid has to stay scannable at three cards across. So the
 *  hierarchy is dense and quiet — one accent (the project's own mark), one voice per band, no ornament.
 *
 *  What is core's here is presentation. The status pill, the meters and the row actions are all a PLUGIN's
 *  words about a project it owns the runtime of; this file draws them and never learns their vocabulary. */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, ArrowUpRight, Folder, GitBranch, HardDrive, MoreHorizontal } from 'lucide-react';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { MeterBar } from '../../components/ui/MeterBar';
import { Spinner } from '../../components/ui/states';
import { Tooltip, TooltipAnchor, TooltipContent } from '../../components/ui/shadcn/tooltip';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { useEffects } from '../../lib/useEffects';
import type { Project, ProjectSummary } from '../../lib/types';
import type { PluginProjectRowMetric, PluginProjectRowMetrics, PluginProjectRowStatus, PluginProjectRowTone } from '../../lib/pluginProjectRows';
import { usageProgressColour } from '../settings/OAuthUsageRail';

const ROW_STATUS_TONE: Record<PluginProjectRowTone, string> = {
  muted: 'text-muted-foreground',
  accent: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

function MissingProjectPathBadge({ label }: { label: string }) {
  return <Badge tone="danger"><AlertTriangle size={11} className="mr-1" aria-hidden />{label}</Badge>;
}

/** `grid` is the drawer's three abreast, `rows` is the card's stack. Named rather than left to a
 *  className, because the two arrangements put the figure in different places and a caller cannot express
 *  that with a utility. */
export type ProjectMetricsLayout = 'grid' | 'rows';

/** A plugin's word on what this project is DOING, as a pill in the card's runtime band.
 *
 *  On a row the state was a bare glyph whose accessible name carried the meaning, because a row had one
 *  narrow track to spend. A card has a band, so the plugin's own wording is on screen rather than behind a
 *  hover — which is the whole point of a state report, and the one thing a coloured dot cannot do. The
 *  glyph goes silent for the same reason: the label beside it already says it, and announcing both makes
 *  a screen reader read the state twice. */
function ProjectRowStatus({ status }: { status?: PluginProjectRowStatus }) {
  if (!status) return null;
  const Icon = pluginLucideIcon(status.icon);
  const tone = ROW_STATUS_TONE[status.tone ?? 'muted'];
  return (
    <span
      data-project-row-status={status.busy ? 'busy' : status.tone ?? 'muted'}
      // Busy is a property of the state, not a second state: the pill keeps saying which operation is
      // running while it announces that something is in flight.
      aria-busy={status.busy === true || undefined}
      className={`inline-flex min-w-0 shrink items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium leading-5 ${tone}`}
    >
      {status.busy ? <Spinner size="xs" tone={tone} /> : <Icon size={12} aria-hidden />}
      <span className="truncate">{status.label}</span>
    </span>
  );
}

/** ONE measured resource of the snapshot its owning plugin published.
 *
 *  CPU, memory and disk are drawn with ONE grammar, and it is the charting library's: `MeterBar` is a
 *  recharts bar over a fixed 0..100 domain, the flat sibling of the dials on the System screen. All three
 *  now qualify for it, because disk stopped being the odd reading out — the plugin measures it against
 *  the volume the environment is stored on rather than against a quota it never had.
 *
 *  A meter is still drawn for `ready` and for nothing else, because `ready` is the only state carrying a
 *  percentage against a ceiling that exists. `absolute` is an equally real figure whose ceiling could not
 *  be read, and `loading`, `stopped` and `unavailable` carry no figure at all. All four get a dashed
 *  channel in the meter's place: the card keeps one rhythm, and a filled bar never claims a proportion of
 *  something that was never measured.
 *
 *  The figure sits ABOVE the bar rather than after the label. At three cards across, a row of
 *  label + bar + figure puts `640 MiB / 1 GiB` and `CPU` in the same 250px of inline space, and whichever
 *  of the two gives way is the one the reader came for. Stacking them gives the figure the card's whole
 *  width and leaves the label its own column, so nothing has to be clipped to fit. */
function ProjectResourceMeter({ item, layout }: { item: PluginProjectRowMetric; layout: ProjectMetricsLayout }) {
  const percent = item.state === 'ready' && typeof item.percent === 'number' && Number.isFinite(item.percent)
    ? Math.max(0, Math.min(100, item.percent))
    : null;
  const title = item.valueText ?? `${item.label}: ${item.value}`;
  const track = percent === null ? (
    <span
      aria-hidden
      data-metric-track="none"
      className={`block h-1 rounded-full border border-dashed border-border bg-transparent ${item.state === 'loading' ? 'animate-pulse' : ''}`}
    />
  ) : (
    <MeterBar percent={percent} colour={usageProgressColour(percent)} label={item.label} valueText={title} />
  );
  if (layout === 'grid') {
    return (
      <div className="min-w-0" title={title} data-metric={item.id} data-metric-state={item.state}>
        <div className="mb-1 flex min-w-0 items-baseline justify-between gap-1.5 text-[10px] leading-none">
          <span className="shrink-0 font-semibold uppercase tracking-[0.08em] text-muted-foreground">{item.label}</span>
          <span className="min-w-0 truncate tabular-nums text-foreground">{item.value}</span>
        </div>
        {track}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5" title={title} data-metric={item.id} data-metric-state={item.state}>
      <span className="w-11 shrink-0 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{item.label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-right text-[11px] leading-none tabular-nums text-foreground">{item.value}</span>
        {track}
      </div>
    </div>
  );
}

/** The three meters of one snapshot, in the card and in the drawer alike. The figures are the ones the
 *  plugin last measured in EVERY state: a refresh in flight only dims them, and a failed read only marks
 *  them, because replacing a measurement with a placeholder is how a populated environment reported
 *  nothing each time a poll missed. */
export function ProjectResourceMeters({ metrics, layout = 'grid' }: { metrics?: PluginProjectRowMetrics; layout?: ProjectMetricsLayout }) {
  if (!metrics || !Array.isArray(metrics.items) || metrics.items.length === 0) return null;
  const items = metrics.items.slice(0, 3);
  const loading = items.every((item) => item.state === 'loading');
  const label = metrics.stale && metrics.staleLabel ? `${metrics.label} — ${metrics.staleLabel}` : metrics.label;
  return (
    <div
      role={loading ? 'status' : 'group'}
      aria-label={label}
      data-project-row-metrics
      data-metrics-layout={layout}
      data-refreshing={metrics.refreshing ? 'true' : undefined}
      data-stale={metrics.stale ? 'true' : undefined}
      className={`min-w-0 transition-opacity duration-300 ${layout === 'grid' ? 'grid w-full grid-cols-3 gap-x-3' : 'flex flex-col gap-2'} ${metrics.stale ? 'opacity-70' : metrics.refreshing ? 'opacity-80' : ''}`}
    >
      {items.map((item) => <ProjectResourceMeter key={item.id} item={item} layout={layout} />)}
    </div>
  );
}

/** What a project with no measured runtime IS, said plainly instead of drawn as three empty meters.
 *
 *  A host project executes in a directory on the machine Elowen itself runs on. It has no container, no
 *  CPU share and no memory ceiling of its own, so there is nothing to measure and a zeroed meter would be
 *  a fabricated reading rather than a quiet one. The card says what it is and keeps the band's height, so
 *  a grid of mixed projects still reads as a grid. */
function ProjectHostState({ title, hint }: { title: string; hint: string }) {
  return (
    <div data-project-host-state className="flex min-w-0 items-start gap-2.5 rounded-lg border border-dashed border-border px-2.5 py-2">
      <Folder size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
        {/* Wraps rather than truncates. This sentence is the whole reason the card shows no figures, and
            "…container of its ow…" says none of it; two lines here cost less than the three meters it
            stands in for. */}
        <span className="text-[11px] leading-tight text-balance text-muted-foreground">{hint}</span>
      </span>
    </div>
  );
}

/** How far from an edge the pointer has to rest before the strip starts moving under it. */
const TEAM_EDGE_ZONE = 40;
/** One arrow press. About two faces, so a reader paging with the keyboard always gains a whole avatar. */
const TEAM_SCROLL_STEP = 56;
/** Pixels per animation frame while the pointer rests in an edge zone. Slow enough to read faces going
 *  past, and it stops the instant the strip reaches that end — no loop is kept alive against a value that
 *  can no longer change. */
const TEAM_DRIFT_SPEED = 5;

/** Who works on this project: one overlapping strip of faces, and — separately — the control that names
 *  them.
 *
 *  The two are deliberately not one thing. A strip that can scroll must be reachable and scrollable by
 *  keyboard, which makes it a focusable region; a list of names is a tooltip on a control. Merging them
 *  would produce a control whose activation both opens a tip and consumes the arrow keys that scroll it.
 *
 *  Scrolling is the browser's: `overflow-x: auto` already answers touch drag, trackpad swipe and the
 *  arrow keys of a focused region. What is added here is only what a mouse has no gesture for — a wheel
 *  over the strip, and a pointer resting near an end. The drift is a convenience on top of three input
 *  methods that all work without it, so it is gated on the app's own motion preference and never becomes
 *  the only way through the list.
 *
 *  Membership is served to administrators only, so a client that received no list says nothing about it:
 *  "no one assigned" for a reader who was simply not told would be this component's guess. An empty list
 *  IS an answer, and it gets the quiet one. */
function ProjectTeamStrip({ members, labels }: {
  members?: ProjectSummary['members'];
  /** `strip` and `count` are already resolved for THIS project: a register of cards whose scroll regions
   *  are all called "Assigned users of {slug}" is exactly the unusable element list the location mark was
   *  named per project to avoid. */
  labels: { strip: string; count: string; empty: string; more: string };
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const strip = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const drift = useRef<number | null>(null);
  const { ambientMotionEnabled } = useEffects();
  const sampleCount = members?.samples.length ?? 0;

  const measure = useCallback(() => {
    const node = strip.current;
    if (node) setOverflow(node.scrollWidth - node.clientWidth > 1);
  }, []);

  // Overflow is a fact about the RENDERED width, so it is measured rather than derived from a headcount:
  // the same eight faces overflow in a one-column phone card and do not in a three-column desktop one.
  useEffect(() => {
    const node = strip.current;
    if (!node) return undefined;
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, sampleCount]);

  const stopDrift = useCallback(() => {
    if (drift.current !== null) {
      cancelAnimationFrame(drift.current);
      drift.current = null;
    }
    const node = strip.current;
    if (node) node.style.removeProperty('scroll-behavior');
  }, []);
  // A card can be filtered out from under a resting pointer, and a frame callback outliving its element
  // is a leak that only shows up as a register that will not settle.
  useEffect(() => stopDrift, [stopDrift]);

  const startDrift = useCallback((direction: -1 | 1) => {
    if (drift.current !== null) return;
    const node = strip.current;
    if (!node) return;
    // The drift moves the strip a few pixels per frame, so it owns the interpolation. CSS smoothing on
    // top of that is a second animation fighting the first.
    node.style.setProperty('scroll-behavior', 'auto');
    const step = () => {
      const current = strip.current;
      if (!current) { drift.current = null; return; }
      const limit = current.scrollWidth - current.clientWidth;
      const next = Math.max(0, Math.min(limit, current.scrollLeft + direction * TEAM_DRIFT_SPEED));
      if (next === current.scrollLeft) { drift.current = null; current.style.removeProperty('scroll-behavior'); return; }
      current.scrollLeft = next;
      drift.current = requestAnimationFrame(step);
    };
    drift.current = requestAnimationFrame(step);
  }, []);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch drags the strip directly and a pen has no hover, so the drift is a mouse affordance only. A
    // reader who asked for reduced motion keeps the wheel, the drag and the arrow keys.
    if (!overflow || event.pointerType !== 'mouse' || !ambientMotionEnabled) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX - box.left <= TEAM_EDGE_ZONE) startDrift(-1);
    else if (box.right - event.clientX <= TEAM_EDGE_ZONE) startDrift(1);
    else stopDrift();
  };

  // React registers `wheel` passively at the root, so a handler that has to decide whether to take the
  // event from the page cannot be a React prop. It is bound here, non-passively, on the strip itself.
  useEffect(() => {
    const node = strip.current;
    if (!node || !overflow) return undefined;
    const onWheel = (event: WheelEvent) => {
      // Ctrl+wheel (and the pinch gesture it stands in for) is the browser's zoom, not this strip's
      // scroll. Consuming it would scroll the faces under a reader who asked to enlarge the page.
      if (event.ctrlKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const limit = node.scrollWidth - node.clientWidth;
      const next = Math.max(0, Math.min(limit, node.scrollLeft + delta));
      // Only a turn this strip can actually consume is taken from the page. At either end the event keeps
      // travelling, so a pointer that happens to rest on a team never traps the register's own scroll.
      if (next === node.scrollLeft) return;
      event.preventDefault();
      node.scrollLeft = next;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [overflow]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const node = strip.current;
    if (!node) return;
    const limit = node.scrollWidth - node.clientWidth;
    const target = event.key === 'ArrowRight' ? node.scrollLeft + TEAM_SCROLL_STEP
      : event.key === 'ArrowLeft' ? node.scrollLeft - TEAM_SCROLL_STEP
        : event.key === 'Home' ? 0
          : event.key === 'End' ? limit
            : null;
    if (target === null) return;
    // The register's own roving navigation lives on the card, and a reader paging through faces is not
    // asking to move to the next project.
    event.preventDefault();
    event.stopPropagation();
    node.scrollLeft = Math.max(0, Math.min(limit, target));
  };

  if (!members) return null;
  if (members.total === 0) return <span className="sr-only" data-project-team="empty">{labels.empty}</span>;
  const overflowCount = Math.max(0, members.total - members.samples.length);
  const countLabel = labels.count.replace('{n}', String(members.total));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div
        ref={strip}
        data-project-team="strip"
        data-project-team-overflow={overflow ? 'true' : undefined}
        // A scrollable region has to be focusable, or its content is unreachable without a pointer. It is
        // a tab stop only while there is something to scroll: an empty stop on every card would put three
        // inert targets between the reader and the next project.
        {...(overflow ? { tabIndex: 0, role: 'group' as const, 'aria-label': labels.strip } : {})}
        onPointerMove={onPointerMove}
        onPointerLeave={stopDrift}
        onBlur={stopDrift}
        onKeyDown={onKeyDown}
        // The card opens the detail when its quiet surface is clicked. Paging through faces is not that.
        onClick={(event) => event.stopPropagation()}
        className="project-card-team flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <span className="flex shrink-0 -space-x-1.5 pr-0.5">
          {members.samples.map((user) => (
            <span key={user.id} className="rounded-full ring-2 ring-card"><Avatar user={user} size={22} /></span>
          ))}
        </span>
      </div>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipAnchor asChild>
          {/* One control for the whole team, not one per face: a button per avatar inside a card that is
              itself openable is the nested-interactive problem, and voice control would offer eight
              unnamed targets where there is one piece of information. */}
          <button
            type="button"
            data-project-team="detail"
            aria-label={countLabel}
            title={countLabel}
            aria-describedby={open ? tooltipId : undefined}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onClick={(event) => { event.stopPropagation(); setOpen(true); }}
            className="shrink-0 rounded-full px-1 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            {members.total}
          </button>
        </TooltipAnchor>
        <TooltipContent id={tooltipId} align="end" className="w-56">
          <ul className="flex flex-col gap-1">
            {members.samples.map((user) => (
              <li key={user.id} className="truncate">
                <span className="text-foreground">{user.name || user.username}</span>
                <span className="ml-1.5 text-muted-foreground">@{user.username}</span>
              </li>
            ))}
            {overflowCount > 0 ? <li className="text-muted-foreground">{labels.more.replace('{n}', String(overflowCount))}</li> : null}
          </ul>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Where the project actually LIVES, behind one quiet mark instead of a line of path.
 *
 *  A host path and a managed environment's guest root are both long, both monospaced and both read the
 *  same at a glance, which is what made the old Path column the widest and least useful thing in the
 *  register. The mark is named for the project it belongs to, so an element list reads "Host directory of
 *  elowen" rather than a row of buttons all called "Path". */
function ProjectLocationTip({ project, labels }: {
  project: Project;
  labels: { host: string; managed: string; hostTitle: string; guestRoot: string; adoptedFrom: string };
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const managed = project.executionKind === 'managed';
  const Icon = managed ? HardDrive : Folder;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipAnchor asChild>
        <Button
          variant="ghost"
          size="icon"
          data-project-location={managed ? 'managed' : 'host'}
          className="h-6 w-6 shrink-0 text-muted-foreground"
          aria-label={(managed ? labels.managed : labels.host).replace('{slug}', project.slug)}
          aria-describedby={open ? tooltipId : undefined}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        >
          <Icon size={12} aria-hidden />
        </Button>
      </TooltipAnchor>
      <TooltipContent id={tooltipId} align="start" className="w-64">
        <dl className="flex flex-col gap-1.5">
          <div className="flex flex-col gap-0.5">
            <dt className="uppercase tracking-[0.08em]">{managed ? labels.guestRoot : labels.hostTitle}</dt>
            <dd className="break-all font-mono text-foreground">{managed ? (project.guestRoot ?? '/') : project.path}</dd>
          </div>
          {/* A managed project converted from a host directory keeps that directory on record, and it is
              the only remaining way to recognise where its contents came from. */}
          {project.adoptedPath ? (
            <div className="flex flex-col gap-0.5">
              <dt className="uppercase tracking-[0.08em]">{labels.adoptedFrom}</dt>
              <dd className="break-all font-mono text-foreground">{project.adoptedPath}</dd>
            </div>
          ) : null}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

export interface ProjectCardLabels {
  open: string;
  openShort: string;
  actions: string;
  runtimeManaged: string;
  runtimeHost: string;
  runtimeManagedTitle: string;
  runtimeHostTitle: string;
  hostStateTitle: string;
  hostStateHint: string;
  branch: string;
  pathMissing: string;
  team: { strip: string; count: string; empty: string; more: string };
  location: { host: string; managed: string; hostTitle: string; guestRoot: string; adoptedFrom: string };
}

/** What the card says under the project's name: what this project is FOR, in the words the register
 *  already holds. Notes first, because that is the sentence somebody wrote about it; failing that, the
 *  place it runs, which is at least true. Never a fabricated tagline. */
function identityLine(project: Project, labels: ProjectCardLabels): string {
  const note = project.notes.trim().split('\n', 1)[0]?.trim();
  if (note) return note;
  return project.executionKind === 'managed' ? labels.runtimeManagedTitle : project.path;
}

export function ProjectCard({ project, selected, metrics, status, actions, members, branch, labels, onOpen, onContextMenu, onKeyDown }: {
  project: Project;
  selected: boolean;
  metrics?: PluginProjectRowMetrics;
  status?: PluginProjectRowStatus;
  actions: ActionMenuItem[];
  members?: ProjectSummary['members'];
  branch?: string;
  labels: ProjectCardLabels;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const managed = project.executionKind === 'managed';
  const openLabel = labels.open.replace('{slug}', project.slug);
  return (
    <div role="listitem" className="min-w-0">
      {/* The card is not a button. It carries a heading, a scrollable region, a tooltip control, a menu
          and an open control, and a button wrapping all of that is a control containing controls. The
          quiet surface still opens the project on click — that is the pointer affordance — while the
          keyboard path is the real open button in the footer, which is also the card's single tab stop. */}
      <div
        data-project-card={project.id}
        data-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        className={`group flex h-full min-w-0 cursor-pointer flex-col gap-3 rounded-xl border bg-card p-3.5 transition-colors ${selected ? 'border-primary/60 bg-primary/[0.055]' : 'border-border hover:border-primary/40'}`}
      >
        {/* Identity. The mark is the card's one piece of colour; everything below it is quiet on purpose. */}
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/60">
            <ProjectIcon project={project} size={project.icon ? 40 : 20} className="text-muted-foreground" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              {/* Level 2, not 3: the register's page title is the hero's `h1` and nothing sits between
                  it and a card, so a project is the next level down — not a step skipped. */}
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground transition-colors group-hover:text-primary" title={project.slug}>{project.slug}</h2>
              <ProjectLocationTip project={project} labels={labels.location} />
            </span>
            <p className="min-w-0 truncate text-xs leading-tight text-muted-foreground" title={identityLine(project, labels)}>
              {identityLine(project, labels)}
            </p>
          </div>
          {/* The actions menu is a MENU: it owns the arrow keys, Home and End while it is open, and the
              panel is deliberately not portalled (see shadcn/dropdown-menu), so those keystrokes bubble
              through the card. They must not also move the register's selection — a reader walking the
              menu would watch the grid jump a project per press. The card's own roving navigation stays
              on everything else inside it. */}
          <span
            className="shrink-0"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <ActionMenu
              label={`${project.slug}: ${labels.actions}`}
              items={actions}
              trigger={<MoreHorizontal size={16} aria-hidden />}
              triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            />
          </span>
        </div>

        {/* Runtime. The plugin's state, core's execution target, and the one fact that is neither: a host
            directory that is no longer there. The warning is NOT behind the location mark — a directory
            that is gone is a fact about the project, not a detail to go looking for. */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ProjectRowStatus status={status} />
          <span
            data-project-runtime={managed ? 'managed' : 'host'}
            title={managed ? labels.runtimeManagedTitle : labels.runtimeHostTitle}
            className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium leading-5 text-muted-foreground"
          >
            {managed ? labels.runtimeManaged : labels.runtimeHost}
          </span>
          {project.pathExists === false ? <MissingProjectPathBadge label={labels.pathMissing} /> : null}
        </div>

        {/* Team. Its own band, because a strip that scrolls cannot share a line with something that must
            not move under the pointer. */}
        <ProjectTeamStrip
          members={members}
          labels={{ ...labels.team, strip: labels.team.strip.replace('{slug}', project.slug) }}
        />

        {/* Measurement. A project whose runtime nobody measures says so instead of showing empty meters;
            `mt-auto` keeps the footer on the card's floor so a grid of uneven cards still lines up. */}
        <div className="mt-auto min-w-0">
          {metrics
            ? <ProjectResourceMeters metrics={metrics} layout="rows" />
            : managed ? null : <ProjectHostState title={labels.hostStateTitle} hint={labels.hostStateHint} />}
        </div>

        <div className="flex min-w-0 items-center gap-2 border-t border-border/70 pt-2.5">
          {branch ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" data-project-branch title={`${labels.branch}: ${branch}`}>
              <GitBranch size={12} className="shrink-0" aria-hidden />
              <span className="min-w-0 truncate font-mono">{branch}</span>
            </span>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            data-project-card-open
            aria-label={openLabel}
            onClick={(event) => { event.stopPropagation(); onOpen(); }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            {labels.openShort}
            <ArrowUpRight size={12} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
