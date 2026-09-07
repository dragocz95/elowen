'use client';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Circle, ChevronRight, CornerDownRight, FileCode, FileJson, MoreHorizontal } from 'lucide-react';
import { elowenClient } from '../../lib/elowenClient';
import { openBrainSession } from '../../lib/brainDock';
import { localDateTime, formatTokens } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../ui/Toast';
import { useConversationJobLinks, useMe, QUERY_KEYS } from '../../lib/queries';
import {
  buildConversationTree,
  filterConversationTree,
  groupJobLinks,
  sortConversationTree,
  type ConversationRow,
  type ConversationTreeNode,
} from '../../lib/conversationTree';
import { ScheduledJobLink, scheduledJobName } from './ScheduledJobLink';
import type { ConversationJobLink } from '../../lib/types';
import { Avatar } from '../ui/Avatar';
import { ModelIcon } from '../ui/ModelIcon';
import { PlatformIcon } from '../ui/PlatformIcon';
import { Pager } from '../ui/Pager';
import { RegisterSearch } from '../ui/RegisterSearch';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { HelpTip } from '../ui/HelpTip';
import { Button } from '../ui/Button';
import { DataTable, DataTableCell, DataTableRow, DataTableSortCell, type SortDirection } from '../ui/DataTable';
import { ActionMenu } from '../ui/ActionMenu';
import { ContextMenu, type ContextMenuState } from '../ui/ContextMenu';
import { ControlSurfaceRegister, ControlSurfaceToolbar } from '../ui/ControlSurface';
import { LoadingLine } from '../ui/states';

/** The page is sized to the dialog instead of being a fixed count. The register lives in a FIXED-height
 *  modal (`lg` is `h-[88dvh]`), so twelve rows left a dead band under the table on a large screen while
 *  still overflowing a short one — the table stopped where the dialog kept going.
 *
 *  Only the VIEWPORT is measured, never the content: the scroll box takes its height from flex, so how
 *  many rows are shown cannot feed back into how much room there is, and the observer cannot oscillate.
 *  Where nothing can be measured (a zero-height box, jsdom) the fallback stands. */
const FALLBACK_PAGE_SIZE = 12;
const MIN_PAGE_SIZE = 4;
const FALLBACK_ROW_HEIGHT = 44;

/** How far one nesting level shifts a row, and how many levels are allowed to shift it. Past the cap the
 *  ancestry is still there — the rows are still nested under their parent and still only reachable
 *  through it — but a deep chain stops eating the title column on a narrow register. */
const INDENT_STEP = 16;
const MAX_INDENT_LEVELS = 4;

/** One shared empty set for "nothing is expanded", so an unfiltered render keeps the same identities and
 *  the memo below it does not recompute on every keystroke elsewhere in the panel. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Platforms that are MACHINE work rather than a place people talk: a delegated sub-agent and a scheduled
 *  run. The account that owns those really did start them, so they are never re-labelled as hosted. */
const MACHINE_PLATFORMS = new Set(['subagent', 'cron']);

/** Whether this row's owner merely HOSTS the transcript instead of being the person talking in it — a
 *  shared platform room, which core deliberately anchors on the instance operator because a room has no
 *  single author (see `direct` on ManagedSessionView). A direct 1:1 chat is genuinely its owner's. */
const hostedRoom = (s: ConversationRow): boolean =>
  s.kind === 'channel' && !!s.platform && !s.direct && !MACHINE_PLATFORMS.has(s.platform);

type SortKey = 'title' | 'owner' | 'model' | 'tokens' | 'updated';

/** The order a column takes when it is first clicked: text reads naturally A→Z, while a number and a
 *  timestamp are almost always wanted biggest/newest first. */
const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = { title: 'asc', owner: 'asc', model: 'asc', tokens: 'desc', updated: 'desc' };

/** The register's sort, as one comparator over rows so the roots and every sibling set get the same
 *  order. Each key falls back to recency, which keeps rows with an equal key stable and meaningful. */
function rowComparator(sort: SortKey, direction: SortDirection): (a: ConversationRow, b: ConversationRow) => number {
  const flip = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    switch (sort) {
      case 'title': return flip * a.title.localeCompare(b.title) || b.updated_at.localeCompare(a.updated_at);
      case 'owner': return flip * (a.ownerLabel ?? '').localeCompare(b.ownerLabel ?? '') || b.updated_at.localeCompare(a.updated_at);
      case 'model': return flip * a.model.localeCompare(b.model) || b.updated_at.localeCompare(a.updated_at);
      case 'tokens': return flip * ((a.tokens ?? 0) - (b.tokens ?? 0)) || b.updated_at.localeCompare(a.updated_at);
      default: return flip * a.updated_at.localeCompare(b.updated_at);
    }
  };
}

// Model first, then the conversation, its owner, the tokens it burned and when it last moved.
const COLUMNS = 'minmax(0,1.2fr) minmax(0,2.4fr) minmax(0,1.2fr) 5.5rem 10rem 2.25rem';
const COMPACT_COLUMNS = 'minmax(0,1fr) 2.25rem';
const MOBILE_COLUMNS = 'minmax(0,1.6fr) minmax(0,1fr) 2.25rem';

/** The administrator's conversation register: every account's conversations, with delegated sessions
 *  nested under the conversation that started them. It is one of the two views of the conversation
 *  switcher, which owns that choice and shows the personal list itself — so this panel no longer carries
 *  an all/mine control or a personal query of its own. `afterOpen` lets that host dismiss itself once a
 *  row hands the conversation to the chat surface. */
export function BrainSessionsPanel({ afterOpen }: { afterOpen?: () => void } = {}) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const myId = me.data?.user?.id;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(FALLBACK_PAGE_SIZE);
  // The measurement's own view of the current size: the observer must compare against the latest value
  // without re-subscribing, and reading it out of state would pin the callback to a stale render.
  const pageSizeRef = useRef(FALLBACK_PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Prefix for the row ids the disclosure buttons point `aria-controls` at — the register can be mounted
  // twice (the chat modal over the settings page), and two rows may not share one id.
  const uid = useId();

  // Accounts are read only to put a FACE on the owner column — the rows already carry the name. An
  // ordinary user never sees a foreign row, so the admin-only endpoint stays unasked for them.
  const users = useQuery({ queryKey: ['users'], queryFn: elowenClient.listUsers, enabled: isAdmin });
  const userById = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u])), [users.data]);
  const q = useQuery({ queryKey: ['brain-managed-sessions'], queryFn: elowenClient.brainManagedSessions, enabled: isAdmin });
  // The recurring jobs organized under these conversations. Read once for the whole register — search has
  // to see every link before the roots are paged.
  const jobLinks = useConversationJobLinks('all');
  const sessions: ConversationRow[] = useMemo(() => q.data ?? [], [q.data]);
  const jobsByConversation = useMemo(() => groupJobLinks(jobLinks.data?.links ?? []), [jobLinks.data]);
  // The forest is built BEFORE filtering, sorting and pagination: a child has to find its parent among
  // every row the daemon sent, not only among the ones this page happens to show.
  const tree = useMemo(() => buildConversationTree(sessions, jobsByConversation), [sessions, jobsByConversation]);

  const needle = search.trim().toLowerCase();
  // The search covers the owner too, so narrowing to one person needs no separate filter control.
  const filtered = useMemo(() => (needle
    ? filterConversationTree(tree, needle, (r) => `${r.title} ${r.ownerLabel ?? ''} ${r.model}`.toLowerCase().includes(needle))
    : { roots: tree, expanded: EMPTY_IDS, jobsExpanded: EMPTY_IDS }), [tree, needle]);
  const visible = useMemo(
    () => sortConversationTree(filtered.roots, rowComparator(sort, direction)),
    [filtered.roots, sort, direction],
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  // A page is a page of ROOTS. Whatever an open branch adds scrolls inside the same viewport and never
  // pushes a conversation onto the next page.
  const pageRows = visible.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

  // Manual expansion, keyed by session id and branch kind, kept for as long as the register is mounted —
  // a refetch must not fold a branch the reader opened. The search adds its own temporary expansion on
  // top WITHOUT writing here, which is what restores the reader's own state when the query is cleared.
  const [openBranches, setOpenBranches] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [openJobBranches, setOpenJobBranches] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const branchOpen = (id: string): boolean => openBranches.has(id) || filtered.expanded.has(id);
  const jobBranchOpen = (id: string): boolean => openJobBranches.has(id) || filtered.jobsExpanded.has(id);
  const toggle = (setter: typeof setOpenBranches) => (id: string) => setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => { setPage(0); }, [search, sort, direction]);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const available = box.clientHeight;
      if (available <= 0) return; // hidden or unmeasurable — keep the last good answer rather than guessing
      // The header row is inside the scroll box, so it eats from the same budget. Reading both heights off
      // the live DOM keeps this honest when density, font size or zoom changes.
      const rows = box.querySelectorAll('[role="row"]');
      const headHeight = rows[0]?.getBoundingClientRect().height ?? 0;
      // A ROOT row, explicitly marked, because the page counts roots. The first body row used to do, and
      // stopped the day one of them could be a nested sub-agent or a job link: those are shorter and
      // denser, so measuring one would claim more conversations fit than actually do.
      const rowHeight = box.querySelector('[data-tree-row="root"]')?.getBoundingClientRect().height ?? FALLBACK_ROW_HEIGHT;
      if (rowHeight <= 0) return;
      const next = Math.max(MIN_PAGE_SIZE, Math.floor((available - headHeight) / rowHeight));
      const prev = pageSizeRef.current;
      if (prev === next) return;
      pageSizeRef.current = next;
      setPageSize(next);
      // Keep the reader where they were: the first row on screen stays on screen across a resize.
      setPage((p) => Math.floor((p * prev) / next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /** Clicking the active column reverses it; a different column starts at its own natural order. */
  const sortBy = (key: SortKey) => {
    if (key === sort) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDirection(DEFAULT_DIRECTION[key]); }
  };

  const refresh = () => {
    // Deleting conversations here also removes whatever job branches hung under them: the schedules
    // survive, but the daemon stops resolving their filing, so the navigation read is asked again.
    void qc.invalidateQueries({ queryKey: QUERY_KEYS.brainConversationLinks });
    return qc.invalidateQueries({ queryKey: ['brain-managed-sessions'] });
  };

  const doDelete = async (id: string) => {
    setConfirmId(null);
    try {
      await elowenClient.brainDeleteManagedSession(id);
      await refresh();
      toast(t.sessionsPanel.deleted, 'ok');
    } catch { toast(t.common.error, 'error'); }
  };
  const doExport = async (id: string, format: 'html' | 'jsonl') => {
    try { await elowenClient.brainExportSession(id, format); }
    catch { toast(t.common.error, 'error'); }
  };
  const doDeleteAll = async () => {
    setConfirmAll(false);
    try {
      // Delete what is on screen, and this list is every account's — the endpoint is told so explicitly.
      const { deleted } = await elowenClient.brainDeleteAllManagedSessions('all');
      await refresh();
      toast(`${t.sessionsPanel.deletedAll} (${deleted})`, 'ok');
    }
    catch { toast(t.common.error, 'error'); }
  };

  const rowActions = (session: ConversationRow) => [
    { label: t.sessionsPanel.exportHtml, icon: FileCode, onSelect: () => { void doExport(session.id, 'html'); } },
    { label: t.sessionsPanel.exportJsonl, icon: FileJson, onSelect: () => { void doExport(session.id, 'jsonl'); } },
    { label: t.common.delete, icon: Trash2, tone: 'danger' as const, onSelect: () => setConfirmId(session.id) },
  ];

  const openRowContextMenu = (event: React.MouseEvent, session: ConversationRow) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: rowActions(session).map((item) => ({
        label: item.label,
        icon: item.icon,
        danger: item.tone === 'danger',
        onClick: item.onSelect,
      })),
    });
  };

  // Row ids for `aria-controls`. The session id goes through `encodeURIComponent` because a channel id
  // carries `:` and `@` and an id list is space-separated — the encoding is reversible, so two different
  // conversations can never collide on one DOM id.
  const rowDomId = (sessionId: string) => `${uid}-row-${encodeURIComponent(sessionId)}`;
  const jobsRowDomId = (sessionId: string) => `${uid}-jobs-${encodeURIComponent(sessionId)}`;
  const indentOf = (depth: number) => ({ paddingInlineStart: Math.min(depth, MAX_INDENT_LEVELS) * INDENT_STEP });

  /** The leading slot of the title cell: the branch disclosure when there is something to reveal, the
   *  nesting mark on a leaf below the top level, and nothing at all on a leaf root.
   *
   *  It is a button of its own, beside the title button and never inside it — opening a branch and
   *  opening the conversation are two different acts, and a control nested in another is invalid anyway.
   *  The revealed rows are table rows, so they have no single wrapper to point `aria-controls` at; the
   *  ids of the rows this button reveals are listed instead. */
  const branchToggle = (node: ConversationTreeNode): ReactNode => {
    const hasBranch = node.children.length > 0 || node.jobs.length > 0;
    if (!hasBranch) {
      return node.depth > 0
        ? <CornerDownRight size={12} aria-hidden className="w-5 shrink-0 text-muted-foreground/70" />
        : <span aria-hidden className="w-5 shrink-0" />;
    }
    const open = branchOpen(node.row.id);
    // Named after what it actually uncovers. A conversation that delegated nothing has only its schedules
    // branch below it, and the digit — which counts SESSIONS — is hidden there, so the tooltip explaining
    // that digit goes with it.
    const delegated = node.children.length > 0;
    const revealed = [
      ...(node.jobs.length > 0 ? [jobsRowDomId(node.row.id)] : []),
      ...node.children.map((child) => rowDomId(child.row.id)),
    ];
    return (
      <button
        type="button"
        onClick={() => toggle(setOpenBranches)(node.row.id)}
        aria-expanded={open}
        // Only while the rows exist: a closed branch is unmounted, and an IDREF pointing at nothing is
        // worse than no reference at all.
        aria-controls={open ? revealed.join(' ') : undefined}
        aria-label={(delegated ? t.sessionsPanel.subAgentsToggle : t.scheduledJobs.branchToggle)
          .replace('{title}', node.row.title || t.sessionsPanel.untitled)}
        // What the bare number beside the chevron counts. The accessible name already says it; this is
        // for the pointer, which otherwise reads a digit with nothing attached to it.
        title={delegated ? t.sessionsPanel.subAgents : undefined}
        className="flex shrink-0 items-center gap-0.5 rounded-md px-0.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <ChevronRight size={12} aria-hidden className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        {node.descendantCount > 0 ? (
          <span className="font-mono text-tiny tabular-nums">{node.descendantCount}</span>
        ) : null}
      </button>
    );
  };

  const sessionRow = (node: ConversationTreeNode): ReactNode => {
    const s = node.row;
    // Own conversations (web/CLI) resume & continue in the web chat; channel (Discord) and
    // task-worker sessions open read-only (the daemon won't let the owner post into them).
    // A foreign conversation opens READ-ONLY: the daemon lets an admin read the transcript
    // but never accept a post into it, so offering "continue" would just fail at send.
    const foreign = s.ownerId !== undefined && myId !== undefined && s.ownerId !== myId;
    const continuable = s.kind === 'conversation' && !foreign;
    const label = continuable ? t.sessionsPanel.openInChat : t.sessionsPanel.viewInChat;
    const title = s.title || t.sessionsPanel.untitled;
    // A session whose owner is not in the account list (or a list this caller may not read)
    // still deserves a face, so fall back to the name the row carries.
    const owner = s.ownerId == null ? undefined
      : userById.get(s.ownerId) ?? { id: s.ownerId, username: s.ownerLabel || String(s.ownerId) };
    // The person who last wrote here, resolved the same way — used on a shared room, where the
    // owner names the account hosting the transcript rather than anyone talking in it.
    const writer = s.lastWriterId == null ? undefined
      : userById.get(s.lastWriterId) ?? { id: s.lastWriterId, username: s.lastWriterLabel || String(s.lastWriterId) };
    return (
      // `data-tree-row` is what the page measurement reads: only a ROOT is a page unit.
      <DataTableRow
        key={s.id}
        id={rowDomId(s.id)}
        data-tree-row={node.depth === 0 ? 'root' : 'descendant'}
        interactive
        className="group"
        onContextMenu={(event) => openRowContextMenu(event, s)}
      >
        <DataTableCell priority="mobile" lines={1}>
          <span className="flex min-w-0 items-center gap-1.5" title={s.model}>
            <ModelIcon name={s.model} size={14} />
            <span className="truncate text-xs text-muted-foreground">{s.model}</span>
          </span>
        </DataTableCell>
        {/* The title IS the row's control here, so the cell keeps its focus ring and its own
            layout instead of being clipped; the label inside truncates on its own. */}
        <DataTableCell lines="auto" style={indentOf(node.depth)}>
          <span className="flex min-w-0 items-center gap-1">
            {branchToggle(node)}
            <button
              type="button"
              onClick={() => { openBrainSession(s.id, continuable); afterOpen?.(); }}
              title={label}
              aria-label={`${label}: ${title}`}
              className="flex w-full min-w-0 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              <span className="truncate text-sm text-foreground transition-colors group-hover:text-primary">{title}</span>
              {/* WHERE the conversation happened. A web chat carries no mark — it is the norm
                  here and labelling every row would be noise. */}
              {s.platform ? <PlatformIcon platform={s.platform} /> : null}
              {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
            </button>
          </span>
        </DataTableCell>
        <DataTableCell priority="wide" lines={1}>
          {/* The account row when it is known (it carries the uploaded picture); otherwise the
              name the session itself reported, which still yields a monogram. */}
          {/* On a SHARED room the person who writes is the useful answer, and it is NOT the
              owner: a room has no single author, so core anchors it on the operator. Show the
              writer there and mark the account as merely hosting the transcript. Everywhere
              else the owner IS the person talking, and nothing changes. */}
          {hostedRoom(s) && writer ? (
            <span className="flex min-w-0 items-center gap-2" title={s.lastWriterLabel ?? ''}>
              <Avatar user={writer} size={20} />
              <span className="truncate text-xs text-muted-foreground">{s.lastWriterLabel}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-tiny text-muted-foreground">{t.sessionsPanel.roomBadge}</span>
            </span>
          ) : owner ? (
            <span className="flex min-w-0 items-center gap-2" title={s.ownerLabel ?? ''}>
              <Avatar user={owner} size={20} />
              <span className="truncate text-xs text-muted-foreground">{s.ownerLabel ?? ''}</span>
              {hostedRoom(s) ? (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-tiny text-muted-foreground">{t.sessionsPanel.roomBadge}</span>
              ) : null}
            </span>
          ) : null}
        </DataTableCell>
        <DataTableCell priority="wide" lines={1} className="text-right font-mono text-tiny text-muted-foreground">
          {s.tokens != null ? formatTokens(s.tokens) : ''}
        </DataTableCell>
        <DataTableCell priority="wide" lines={1} className="font-mono text-tiny text-muted-foreground">{localDateTime(s.updated_at, locale, false)}</DataTableCell>
        <DataTableCell lines="auto">
          <ActionMenu
            label={`${title}: ${t.common.actions}`}
            items={rowActions(s)}
            trigger={<MoreHorizontal size={16} aria-hidden />}
            triggerClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          />
        </DataTableCell>
      </DataTableRow>
    );
  };

  /** The schedules organized under a conversation, as their own labelled branch. They are NOT sessions:
   *  they carry no owner face, no token total and no row actions, and they are counted separately. */
  const jobsBranchRow = (node: ConversationTreeNode): ReactNode => {
    const open = jobBranchOpen(node.row.id);
    return (
      <DataTableRow key={`${node.row.id}:jobs`} id={jobsRowDomId(node.row.id)} data-tree-row="jobs">
        <DataTableCell priority="mobile" lines={1}>{null}</DataTableCell>
        <DataTableCell lines="auto" style={indentOf(node.depth + 1)}>
          <button
            type="button"
            onClick={() => toggle(setOpenJobBranches)(node.row.id)}
            aria-expanded={open}
            aria-controls={open ? node.jobs.map((link) => `${jobsRowDomId(node.row.id)}-${encodeURIComponent(link.jobId)}`).join(' ') : undefined}
            aria-label={t.scheduledJobs.toggle.replace('{title}', node.row.title || t.sessionsPanel.untitled)}
            className="flex min-w-0 items-center gap-1 rounded-md px-0.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <ChevronRight size={12} aria-hidden className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
            <span className="truncate text-xs">{t.scheduledJobs.branch}</span>
            <span className="font-mono text-tiny tabular-nums">{node.jobs.length}</span>
          </button>
        </DataTableCell>
        <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
        <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
        <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
        <DataTableCell lines="auto">{null}</DataTableCell>
      </DataTableRow>
    );
  };

  /** One schedule. Following it opens the conversation the job's runs actually landed in — reading that
   *  transcript changes nothing about when the job runs or where its result goes. Where the daemon could
   *  not name one (a schedule that has never fired) the row falls back to the job's own editor. */
  const jobRow = (node: ConversationTreeNode, link: ConversationJobLink): ReactNode => {
    const jobLabel = scheduledJobName(link, t.scheduledJobs);
    const jobClass = 'flex w-full min-w-0 items-center gap-1.5 rounded-md text-left text-xs text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';
    const run = link.run;
    return (
    <DataTableRow key={`${node.row.id}:job:${link.jobId}`} id={`${jobsRowDomId(node.row.id)}-${encodeURIComponent(link.jobId)}`} data-tree-row="job">
      <DataTableCell priority="mobile" lines={1}>{null}</DataTableCell>
      <DataTableCell lines="auto" style={indentOf(node.depth + 2)}>
        {run ? (
          <button
            type="button"
            onClick={() => { openBrainSession(run.sessionId, run.continuable); afterOpen?.(); }}
            aria-label={jobLabel}
            className={jobClass}
          >
            <ScheduledJobLink link={link} labels={t.scheduledJobs} />
          </button>
        ) : (
          <Link href={link.href} onClick={() => afterOpen?.()} aria-label={jobLabel} className={jobClass}>
            <ScheduledJobLink link={link} labels={t.scheduledJobs} />
          </Link>
        )}
      </DataTableCell>
      <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
      <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
      <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
      <DataTableCell lines="auto">{null}</DataTableCell>
    </DataTableRow>
    );
  };

  /** One conversation and, when its branch is open, what hangs under it: first its schedules as their own
   *  collapsed branch, then the sessions it delegated, each recursing the same way. A closed register is
   *  therefore exactly as long as its list of roots. */
  const renderNode = (node: ConversationTreeNode): ReactNode[] => {
    const rows: ReactNode[] = [sessionRow(node)];
    if (!branchOpen(node.row.id)) return rows;
    if (node.jobs.length > 0) {
      rows.push(jobsBranchRow(node));
      if (jobBranchOpen(node.row.id)) for (const link of node.jobs) rows.push(jobRow(node, link));
    }
    for (const child of node.children) rows.push(...renderNode(child));
    return rows;
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ControlSurfaceToolbar testId="brain-sessions-toolbar" layout="split">
        {/* The heading carries the count and the help affordance; the one-line description that used to
            sit under it said what the table already shows. */}
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-base font-semibold text-foreground">{t.sessionsPanel.tab}</h2>
          {visible.length > 0 ? <span className="font-mono text-xs text-muted-foreground">{visible.length}</span> : null}
          <HelpTip align="right">{t.help.sessionsPanel}</HelpTip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The shared register search. Its predecessor here was a hand-built field pinned at `w-44`,
              which could neither grow into a wide toolbar nor shrink out of the way of the bulk-delete
              button on a narrow one. */}
          <RegisterSearch
            value={search}
            onChange={setSearch}
            label={t.sessionsPanel.searchLabel}
            placeholder={t.sessionsPanel.searchLabel}
          />
          {/* It deletes exactly what is listed under it, and the endpoint is told so. Ordinary users have
              no bulk delete at all: nobody asked for one, and a non-admin must never be able to reach
              another account's history. */}
          {isAdmin && visible.length > 0 ? (
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmAll(true)}>{t.sessionsPanel.deleteAll}</Button>
          ) : null}
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister className="flex min-h-0 flex-1 flex-col">
      {/* A failed job read is said out loud. A missing or ungranted cron plugin is `unavailable` and shows
          nothing at all, but a genuine read failure must never be presented as "this conversation has no
          schedules" — that is a wrong answer, not an empty one. */}
      {!q.isError && (jobLinks.data?.status === 'error' || jobLinks.isError) ? (
        <p role="status" className="px-1 pt-1 text-tiny text-muted-foreground">{t.scheduledJobs.error}</p>
      ) : null}
      <div ref={scrollRef} data-testid="brain-sessions-scroll" className="min-h-0 flex-1 overflow-y-auto">
      {q.isLoading ? <LoadingLine />
        : q.isError ? <p className="py-8 text-xs italic text-muted-foreground">{t.common.daemonUnreachable}</p>
        : visible.length === 0 ? <p className="py-8 text-xs italic text-muted-foreground">{sessions.length === 0 ? t.sessionsPanel.empty : t.sessionsPanel.noMatches}</p>
        : (
          <DataTable ariaLabel={t.sessionsPanel.tab} columns={COLUMNS} compactColumns={COMPACT_COLUMNS} mobileColumns={MOBILE_COLUMNS} data-testid="brain-sessions-list">
            <DataTableRow header>
              <DataTableSortCell priority="mobile" active={sort === 'model'} direction={direction} onSort={() => sortBy('model')}>{t.sessionsPanel.colModel}</DataTableSortCell>
              <DataTableSortCell active={sort === 'title'} direction={direction} onSort={() => sortBy('title')}>{t.sessionsPanel.colTitle}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'owner'} direction={direction} onSort={() => sortBy('owner')}>{t.sessionsPanel.owner}</DataTableSortCell>
              <DataTableSortCell priority="wide" align="end" active={sort === 'tokens'} direction={direction} onSort={() => sortBy('tokens')}>{t.sessionsPanel.colTokens}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'updated'} direction={direction} onSort={() => sortBy('updated')}>{t.sessionsPanel.colUpdated}</DataTableSortCell>
              {/* The actions column has no name to print, but it is still a cell: `role="presentation"`
                  would leave a non-cell child inside role="row", which is invalid. */}
              <DataTableCell header lines={1}><span className="sr-only">{t.common.actions}</span></DataTableCell>
            </DataTableRow>
            {pageRows.flatMap(renderNode)}
          </DataTable>
        )}
      </div>

      {/* Inside the register so the pager shares the card's horizontal inset (it used to sit as a
          sibling and hug the card edge). The shared Pager owns the range text, the divider, the disabled
          states and the narrow-width behaviour — this used to be a hand-written copy that borrowed the
          CALENDAR's previous/next labels, so the same control read "Následující" here and "Další" on
          /memory. */}
      {visible.length > 0 ? (
        <Pager
          page={clampedPage}
          pageSize={pageSize}
          total={visible.length}
          onPageChange={setPage}
          ariaLabel={t.sessionsPanel.tab}
        />
      ) : null}
      </ControlSurfaceRegister>

      <ConfirmDialog
        open={confirmId !== null}
        title={t.sessionsPanel.confirmDeleteTitle}
        description={t.sessionsPanel.confirmDeleteDesc}
        onConfirm={() => confirmId ? doDelete(confirmId) : Promise.resolve()}
        onClose={() => setConfirmId(null)}
      />
      {contextMenu ? <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} /> : null}
      <ConfirmDialog
        open={confirmAll}
        title={t.sessionsPanel.confirmDeleteAllTitle}
        // This list is every account's, and wiping the whole team's history says so out loud.
        description={t.sessionsPanel.confirmDeleteAllEveryoneDesc}
        confirmLabel={t.sessionsPanel.deleteAll}
        onConfirm={() => void doDeleteAll()}
        onClose={() => setConfirmAll(false)}
      />
    </section>
  );
}
