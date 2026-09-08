'use client';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle, Clock, Plus, Trash2, MoreHorizontal, Pencil, FileCode, FileJson, GitBranch, ArrowLeft } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { elowenClient } from '../../lib/elowenClient';
import { openBrainComposer, openBrainSession } from '../../lib/brainDock';
import { localDateTime, formatTokens } from '../../lib/format';
import {
  buildConversationTree,
  filterConversationTree,
  groupJobLinks,
  sortConversationTree,
  type ConversationRow,
  type ConversationTreeNode,
} from '../../lib/conversationTree';
import { useConversationJobLinks } from '../../lib/queries';
import { useMeasuredPageSize } from '../../lib/useMeasuredPageSize';
import { ScheduledJobLink, scheduledJobName } from '../../components/brain/ScheduledJobLink';
import { TreeGuide } from '../../components/brain/TreeGuide';
import { subagentBranchRows, type SubagentBranchLabels } from '../../components/brain/SubagentBranch';
import type { BrainSearchHit, BrainSessionInfo, ConversationJobLink } from '../../lib/types';
import { useBrainChat } from './BrainChatProvider';
import { brainModelLabel, brainModelQualifiedLabel } from '../../lib/modelProvider';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { Input } from '../../components/ui/shadcn/input';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Pager } from '../../components/ui/Pager';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { ControlSurfaceRegister, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';
import { DataTable, DataTableCell, DataTableRow, DataTableSortCell, type SortDirection } from '../../components/ui/DataTable';
import { Tooltip, TooltipAnchor, TooltipContent } from '../../components/ui/shadcn/tooltip';

const ACTIVITY_STATES = ['idle', 'working', 'done', 'failed'] as const;
type ActivityState = (typeof ACTIVITY_STATES)[number];
type ActivityView = NonNullable<BrainSessionInfo['activity']>;

type ActivityLabels = {
  idle: string;
  working: string;
  done: string;
  /** What a finished SCHEDULE says instead of the plain "completed" — see {@link ActivityCell}. */
  doneScheduled: string;
  failed: string;
  unread: string;
};

function activityStateOf(activity?: ActivityView): ActivityState {
  return activity?.state && ACTIVITY_STATES.includes(activity.state) ? activity.state : 'idle';
}

/** The state column: what this conversation last did, and — when the last run FAILED — the reason.
 *
 *  A finished SCHEDULE wears the clock its schedules wear rather than the completed check: a tick reads
 *  as "the answer you asked for is ready", and a job firing on its own is not one. Only the completed
 *  state distinguishes them; a failed run is a failed run whoever started it.
 *
 *  The tip hangs off the icon, which is legal now that the state is a CELL of its own — it used to live
 *  inside the row's button, where a second tab stop and a floating panel are both invalid markup. */
function ActivityCell({ activity, labels, unread }: { activity?: ActivityView; labels: ActivityLabels; unread: boolean }) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const state = activityStateOf(activity);
  const scheduled = activity?.automation === 'scheduled';
  const failed = state === 'failed';
  const detail = activity?.detail?.trim();
  const stateLabel = state === 'done' && scheduled ? labels.doneScheduled : labels[state];
  const accessibleLabel = unread ? `${stateLabel}, ${labels.unread}` : stateLabel;

  const icon = state === 'working' ? (
    <Circle size={8} aria-hidden className="animate-pulse fill-success text-success motion-reduce:animate-none" />
  ) : state === 'done' ? (
    scheduled
      ? <Clock size={14} aria-hidden className="text-success" />
      : <CheckCircle2 size={14} aria-hidden className="text-success" />
  ) : failed ? (
    <Circle size={8} aria-hidden className="fill-destructive text-destructive" />
  ) : null;

  return (
    <span data-activity-state={state} className="flex size-5 shrink-0 items-center justify-center">
      <span className="sr-only">{accessibleLabel}</span>
      {failed ? (
        <Tooltip open={open} onOpenChange={setOpen}>
          <TooltipAnchor asChild>
            <button
              type="button"
              aria-describedby={open ? tooltipId : undefined}
              aria-label={accessibleLabel}
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {icon}
            </button>
          </TooltipAnchor>
          <TooltipContent id={tooltipId} side="right" align="start" className="max-w-[min(16rem,calc(100vw-2rem))]">
            <span className="block font-medium text-destructive">{labels.failed}</span>
            {detail ? <span className="mt-1 block break-words">{detail}</span> : null}
          </TooltipContent>
        </Tooltip>
      ) : icon}
    </span>
  );
}

/** A search snippet with the first occurrence of the query highlighted. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-primary/30 px-0.5 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

type SortKey = 'state' | 'model' | 'title' | 'tokens' | 'updated';
/** The order a column takes when it is first clicked: text reads naturally A→Z, while a number and a
 *  timestamp are almost always wanted biggest/newest first. */
const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = { state: 'asc', model: 'asc', title: 'asc', tokens: 'desc', updated: 'desc' };
/** The register's columns, with the owner replaced by the STATE: on a personal list every row belongs to
 *  the reader, so what the conversation last did is the only one of the two that carries information.
 *  The state leads, because it is a glyph and the eye reads the row from it. */
const COLUMNS = '2.25rem minmax(0,1.2fr) minmax(0,2.4fr) 5.5rem 10rem 2.25rem';
/** Below the full layout only the state, the title and the row actions survive, on a phone as on a
 *  tablet. The model was shown on phones and took 1.6fr of a 390px screen, which left the conversation
 *  name clipped to four characters — on the surface whose entire job is picking a conversation by name.
 *  Nothing scrolls sideways here: what does not fit is dropped, never pushed off the edge. */
const COMPACT_COLUMNS = '2.25rem minmax(0,1fr) 2.25rem';

/** One shared empty set for "nothing is expanded", so an unfiltered render keeps the same identities. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
/** The same trick for "no sub-agent branches yet": one identity, so the memos below do not recompute. */
const EMPTY_BRANCHES: Readonly<Record<string, never[]>> = {};

/** The caller's OWN conversations: the register's table, the fulltext search with its snippets, the
 *  activity and unread marks, switch / new / rename / branch / export / delete, and the collapsed branch
 *  of recurring jobs filed under each conversation.
 *
 *  It is a PANEL, not an overlay. The app has exactly one conversation switcher — the shared
 *  `ConversationSwitcherModal` — and this is what it shows under "Just mine"; an administrator's "All" is
 *  the register beside it. Both are now the SAME table: same columns, same sort, same paging, same
 *  schedule branches. Only the owner column differs, for the reason given at {@link COLUMNS}.
 *
 *  Everything here reads the ONE shared controller (BrainChatProvider), so there is never a second
 *  session list or a second mutation surface. Delete goes through the controller (it re-targets the
 *  active conversation); rename/branch/export/search hit the client directly (pure metadata /
 *  read-only). */
export function ConversationHistoryPanel({ onNavigate, homeLink = false }: {
  /** Called once this panel has handed a conversation or a schedule on — the host modal closes on it. */
  onNavigate?: () => void;
  // On a phone /chat hides the global TopBar, so the switcher is also the way back to the rest of the
  // app — it then carries a "← dashboard" link. Off where the TopBar still holds the navigation.
  homeLink?: boolean;
}) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { sessions, switchSession, deleteSession } = useBrainChat();
  const activityLabels: ActivityLabels = {
    idle: t.chat.activityIdle,
    working: t.chat.activityWorking,
    done: t.chat.activityDone,
    doneScheduled: t.chat.activityDoneScheduled,
    failed: t.chat.activityFailed,
    unread: t.chat.activityUnread,
  };

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<BrainSearchHit[] | null>(null);
  // Which conversations have their scheduled-job branch open. Local to this mount and keyed by session
  // id: navigation state, not something to persist or sync across devices.
  const [openJobs, setOpenJobs] = useState<ReadonlySet<string>>(EMPTY_IDS);
  // The sub-agent branches the reader has opened — the group under a conversation, and the individual
  // rows inside it whose own delegations are uncovered. Same lifetime and same reasoning as `openJobs`:
  // navigation state, kept for as long as this mount lives so a refetch cannot fold it back.
  const [openAgents, setOpenAgents] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [openAgentNodes, setOpenAgentNodes] = useState<ReadonlySet<string>>(EMPTY_IDS);
  // The conversations whose branches are worth reading: the page actually on screen. Held in state and
  // written by an effect below the pager rather than derived here, because the page is computed from the
  // job branches this same read provides — deriving it inline would make the answer an input to its own
  // request. Empty until the first page is measured, which asks for the whole authorized listing.
  const [pageIds, setPageIds] = useState<readonly string[]>([]);
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; active: boolean } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [renameStatus, setRenameStatus] = useState<import('../../lib/useAutoSaveStatus').SaveStatus>('idle');
  const [renamePending, setRenamePending] = useState(false);
  const deleteTargetRef = useRef<typeof deleteTarget>(null);
  const deletePendingRef = useRef(false);
  const deleteOpRef = useRef(0);
  const [renameValue, setRenameValue] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pageSize, page, setPage } = useMeasuredPageSize(scrollRef);
  // Prefix for the row ids the disclosure buttons point `aria-controls` at — the switcher can be mounted
  // beside the register, and two rows may not share one id.
  const uid = useId();

  // Debounced conversation search: ≥2 chars queries the daemon; anything shorter restores the list.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      elowenClient.brainSearch(q)
        .then((hits) => { if (!stale) setResults(hits); })
        .catch(() => { if (!stale) setResults([]); });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [search]);

  // Opening something hands the conversation to the chat surface behind the switcher, so the switcher
  // gets out of the way rather than covering what was just loaded.
  const dismiss = () => onNavigate?.();

  // Opening a conversation must also BRING THE CHAT ON SCREEN. Switching the controller alone only works
  // where a chat surface already is: from the dock over a plugin page — or on a phone, where the dock is
  // no surface at all — picking a conversation left the reader on the page they were on, looking at the
  // settings the switcher was covering. `openBrainSession` is the app's one request for that (the
  // register's rows use it too): the shell reveals the dock or routes to /chat, and the controller loads
  // the conversation and reports its own failure. On /chat it resolves to a plain switch.
  const openSession = (opts: { session?: string; fresh?: boolean }) => {
    setSearch('');
    dismiss();
    if (opts.session) { openBrainSession(opts.session, true); return; }
    // A new conversation has no id to request. Switch first, then ask for the live conversation with an
    // empty composer draft — the same event the launcher raises, which reveals the chat and focuses it.
    void switchSession(opts)
      .then(() => openBrainComposer())
      .catch(() => toast(t.brainChat.searchOpenError, 'error'));
  };

  // A rename resolves exactly once. Enter and blur commit; Escape cancels. The guard stops the blur that
  // browsers fire when the focused input unmounts from re-running the commit — otherwise Enter would PATCH
  // twice and Escape (which also unmounts) would commit the edit it was meant to discard.
  const renameDone = useRef(false);
  const beginRename = (id: string, title: string) => {
    renameDone.current = false;
    setRenameStatus('idle');
    setRenamePending(false);
    setRenameValue(title);
    setRenameFor(id);
  };
  const cancelRename = () => { renameDone.current = true; setRenamePending(false); setRenameFor(null); };
  const commitRename = async (id: string) => {
    if (renameDone.current || renamePending) return;
    renameDone.current = true;
    const title = renameValue.trim();
    if (!title) { renameDone.current = false; return; }
    setRenamePending(true);
    setRenameStatus('saving');
    try {
      await elowenClient.brainRenameSession(id, title);
      await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
      setRenamePending(false);
      setRenameStatus('saved');
      setRenameFor(null);
    } catch {
      setRenamePending(false);
      renameDone.current = false;
      setRenameStatus('error');
      toast(t.chat.renameError, 'error');
    }
  };

  // Branch a conversation and open the copy, so the user lands in the new thread and the original stays
  // untouched. The daemon creates it purely in the store, so this is a plain client call like rename.
  const forkSession = async (id: string) => {
    try {
      const fork = await elowenClient.brainForkSession(id);
      openSession({ session: fork.id });
    } catch { toast(t.chat.forkError, 'error'); }
  };

  const exportSession = (id: string, format: 'html' | 'jsonl') => {
    void elowenClient.brainExportSession(id, format).catch(() => toast(t.chat.exportError, 'error'));
  };

  const openDelete = (target: NonNullable<typeof deleteTarget>) => {
    deleteOpRef.current += 1;
    deletePendingRef.current = false;
    deleteTargetRef.current = target;
    setDeletePending(false);
    setDeleteTarget(target);
  };
  const closeDelete = () => {
    deleteOpRef.current += 1;
    deletePendingRef.current = false;
    deleteTargetRef.current = null;
    setDeletePending(false);
    setDeleteTarget(null);
  };
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTargetRef.current;
    if (!target || deletePendingRef.current) return;
    const operation = ++deleteOpRef.current;
    deletePendingRef.current = true;
    setDeletePending(true);
    try {
      await deleteSession(target.id, target.active);
      if (operation !== deleteOpRef.current || deleteTargetRef.current !== target) return;
      deletePendingRef.current = false;
      deleteTargetRef.current = null;
      setDeletePending(false);
      setDeleteTarget(null);
      dismiss();
    } catch {
      if (operation !== deleteOpRef.current || deleteTargetRef.current !== target) return;
      // The provider owns the visible failure toast. Keeping the confirmation and list mounted preserves
      // the exact session state and lets the user retry without rediscovering the conversation.
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  };

  const actionItems = (session: { id: string; title?: string; active: boolean }): ActionMenuItem[] => [
    { label: t.chat.rename, icon: Pencil, onSelect: () => beginRename(session.id, session.title || '') },
    { label: t.chat.fork, icon: GitBranch, onSelect: () => { void forkSession(session.id); } },
    { label: t.chat.exportHtml, icon: FileCode, onSelect: () => exportSession(session.id, 'html') },
    { label: t.chat.exportJsonl, icon: FileJson, onSelect: () => exportSession(session.id, 'jsonl') },
    {
      label: t.brainChat.deleteChat,
      icon: Trash2,
      tone: 'danger',
      onSelect: () => {},
      onAfterClose: () => openDelete({ id: session.id, title: session.title || t.brainChat.untitled, active: session.active }),
    },
  ];

  const q = search.trim();

  // The recurring jobs and sub-agents organized under THIS caller's conversations. The endpoint already
  // bounds `mine` by the personal session list; the render below still only asks the map for sessions
  // that list holds, so a shared platform room can never appear here as a conversation the switcher does
  // not otherwise show. `pageIds` narrows the sub-agent half to the rows on screen — it is computed from
  // the sort, the search and the page alone, never from the branches, so asking for a page cannot change
  // which page is asked for.
  const jobLinks = useConversationJobLinks('mine', pageIds);
  const jobsByConversation = useMemo(() => groupJobLinks(jobLinks.data?.links ?? []), [jobLinks.data]);
  const jobsFailed = jobLinks.data?.status === 'error' || jobLinks.isError;
  const subagents = jobLinks.data?.subagents ?? EMPTY_BRANCHES;
  const subagentsFailed = jobLinks.data?.subagentStatus === 'error';
  const subagentLabels: SubagentBranchLabels = {
    branch: t.subagentBranch.branch,
    toggle: t.subagentBranch.toggle,
    expand: t.subagentBranch.expand,
    workflow: t.subagentBranch.workflow,
    unavailable: t.subagentBranch.unavailable,
    truncated: t.subagentBranch.truncated,
    status: {
      pending: t.subagentBranch.statusPending,
      running: t.subagentBranch.statusRunning,
      blocked: t.subagentBranch.statusBlocked,
      done: t.subagentBranch.statusDone,
      error: t.subagentBranch.statusError,
      interrupted: t.subagentBranch.statusInterrupted,
    },
  };

  const sessionList = useMemo(() => sessions.data ?? [], [sessions.data]);
  const sessionById = useMemo(() => new Map(sessionList.map((s) => [s.id, s])), [sessionList]);
  // The register's row shape, so the shared tree, sort and filter helpers work on exactly one type. A
  // personal conversation is never a channel and never nests, so `kind` is constant and no parent is set.
  const rows: ConversationRow[] = useMemo(() => sessionList.map((s) => ({
    id: s.id,
    title: s.title,
    model: s.model,
    updated_at: s.updated_at,
    running: s.running,
    kind: 'conversation' as const,
    tokens: s.tokens,
  })), [sessionList]);
  const tree = useMemo(() => buildConversationTree(rows, jobsByConversation), [rows, jobsByConversation]);

  /** The newest transcript snippet per conversation, for the rows a search leaves standing. The daemon
   *  returns hits newest-first, so the first one seen for a conversation is the one worth showing. */
  const snippetBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const hit of results ?? []) if (!map.has(hit.sessionId)) map.set(hit.sessionId, hit.snippet);
    return map;
  }, [results]);

  const needle = q.toLowerCase();
  // A conversation answers the query through its own name or model — matched here, live, without waiting
  // for the daemon — or through its transcript, which only the daemon can answer. A schedule name is
  // matched by the shared filter itself, which also opens the branch that schedule sits in.
  const filtered = useMemo(() => (needle.length >= 2
    ? filterConversationTree(tree, needle, (r) =>
      `${r.title} ${r.model}`.toLowerCase().includes(needle) || snippetBySession.has(r.id))
    : { roots: tree, expanded: EMPTY_IDS, jobsExpanded: EMPTY_IDS }), [tree, needle, snippetBySession]);

  const comparator = useMemo(() => {
    const flip = direction === 'asc' ? 1 : -1;
    const stateRank = (id: string): number => ACTIVITY_STATES.indexOf(activityStateOf(sessionById.get(id)?.activity));
    return (a: ConversationRow, b: ConversationRow): number => {
      switch (sort) {
        case 'state': return flip * (stateRank(a.id) - stateRank(b.id)) || b.updated_at.localeCompare(a.updated_at);
        case 'model': return flip * a.model.localeCompare(b.model) || b.updated_at.localeCompare(a.updated_at);
        case 'title': return flip * a.title.localeCompare(b.title) || b.updated_at.localeCompare(a.updated_at);
        case 'tokens': return flip * ((a.tokens ?? 0) - (b.tokens ?? 0)) || b.updated_at.localeCompare(a.updated_at);
        default: return flip * a.updated_at.localeCompare(b.updated_at);
      }
    };
  }, [sort, direction, sessionById]);

  const visible = useMemo(() => sortConversationTree(filtered.roots, comparator), [filtered.roots, comparator]);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  // A page is a page of CONVERSATIONS. Whatever an open schedules branch adds scrolls inside the same
  // viewport and never pushes a conversation onto the next page.
  const pageRows = visible.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);
  // A string, so the effect fires when the PAGE changes rather than on every render that rebuilds the
  // array. This is the one place the branch request learns which conversations to answer for.
  const pageKey = pageRows.map((node) => node.row.id).join(',');

  useEffect(() => { setPage(0); }, [search, sort, direction, setPage]);
  useEffect(() => { setPageIds(pageKey ? pageKey.split(',') : []); }, [pageKey]);

  /** Clicking the active column reverses it; a different column starts at its own natural order. */
  const sortBy = (key: SortKey) => {
    if (key === sort) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDirection(DEFAULT_DIRECTION[key]); }
  };

  const jobsRowDomId = (sessionId: string) => `${uid}-jobs-${encodeURIComponent(sessionId)}`;
  const jobRowDomId = (sessionId: string, jobId: string) => `${jobsRowDomId(sessionId)}-${encodeURIComponent(jobId)}`;
  const jobBranchOpen = (id: string): boolean => openJobs.has(id) || filtered.jobsExpanded.has(id);
  /** Flip one id in a set of open branches, shared by the schedules and the sub-agent group. */
  const toggleIds = (setter: typeof setOpenJobs, id: string) => setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleJobs = (id: string) => toggleIds(setOpenJobs, id);

  /** The row being renamed keeps its place in the table and its columns; only the title cell becomes a
   *  field, so the list does not jump under the reader while they type. */
  const renameRow = (row: ConversationRow): ReactNode => (
    <DataTableRow key={row.id} data-tree-row="root">
      <DataTableCell lines={1}>{null}</DataTableCell>
      <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
      <DataTableCell lines="auto">
        <span className="flex min-w-0 items-center gap-2">
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename(row.id); }
              if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
            }}
            onBlur={() => void commitRename(row.id)}
            disabled={renamePending}
            aria-label={t.chat.renamePlaceholder}
            placeholder={t.chat.renamePlaceholder}
            className="h-8 min-w-0 flex-1 bg-background px-2 py-1 focus-visible:border-primary focus-visible:ring-0"
          />
          <AutoSaveStatus status={renameStatus} onRetry={() => void commitRename(row.id)} />
        </span>
      </DataTableCell>
      <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
      <DataTableCell priority="wide" lines={1}>{null}</DataTableCell>
      <DataTableCell lines="auto">{null}</DataTableCell>
    </DataTableRow>
  );

  const conversationRow = (node: ConversationTreeNode): ReactNode => {
    const row = node.row;
    if (renameFor === row.id) return renameRow(row);
    const session = sessionById.get(row.id);
    const unread = session?.activity?.unread === true;
    const title = row.title || t.brainChat.untitled;
    const snippet = snippetBySession.get(row.id);
    const open = jobBranchOpen(row.id);
    return (
      // `data-tree-row` is what the page measurement reads: only a conversation is a page unit.
      <DataTableRow
        key={row.id}
        data-tree-row="root"
        className="group"
        aria-current={session?.active ? 'page' : undefined}
        onOpen={() => openSession({ session: row.id })}
        openLabel={`${t.sessionsPanel.openInChat}: ${title}`}
      >
        <DataTableCell lines={1}>
          <ActivityCell activity={session?.activity} labels={activityLabels} unread={unread} />
        </DataTableCell>
        <DataTableCell priority="wide" lines={1}>
          <span className="flex min-w-0 items-center gap-1.5" title={brainModelQualifiedLabel({ provider: session?.provider ?? '', model: row.model })}>
            <ModelIcon name={row.model} size={14} />
            <span className="truncate font-mono text-xs text-muted-foreground">{brainModelLabel({ model: row.model })}</span>
          </span>
        </DataTableCell>
        {/* The row itself opens the conversation, so the title is TEXT. The cell still paints above the
            row-wide button (any cell holding a control does), which would have swallowed a tap on the
            name — it therefore passes its pointer events down and only the schedules toggle takes its
            own back. */}
        <DataTableCell lines="auto" className="pointer-events-none">
          <span className="flex min-w-0 items-center gap-1">
            {/* Opening the schedules and opening the conversation are two different acts, so the branch
                keeps a control of its own beside the name. */}
            {node.jobs.length > 0 ? (
              <button
                type="button"
                onClick={() => toggleJobs(row.id)}
                aria-expanded={open}
                aria-controls={open ? node.jobs.map((link) => jobRowDomId(row.id, link.jobId)).join(' ') : undefined}
                aria-label={t.scheduledJobs.toggle.replace('{title}', title)}
                title={t.scheduledJobs.branch}
                className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-md px-0.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              >
                <ChevronRight size={12} aria-hidden className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                <span className="font-mono text-tiny tabular-nums">{node.jobs.length}</span>
              </button>
            ) : <span aria-hidden className="w-5 shrink-0" />}
            <span className="flex min-w-0 flex-1 flex-col text-left">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`truncate text-sm text-foreground transition-colors group-hover:text-primary ${unread ? 'font-semibold' : 'font-normal'}`}>{title}</span>
                {row.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                {unread ? <span aria-hidden data-unread className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
              </span>
              {/* Why this row survived the search, when the reason is not its own name. */}
              {snippet ? (
                <span className="min-w-0 truncate text-tiny text-muted-foreground"><Highlight text={snippet} query={q} /></span>
              ) : null}
            </span>
          </span>
        </DataTableCell>
        <DataTableCell priority="wide" lines={1} className="text-right font-mono text-tiny text-muted-foreground">
          {row.tokens != null ? formatTokens(row.tokens) : ''}
        </DataTableCell>
        <DataTableCell priority="wide" lines={1} className="font-mono text-tiny text-muted-foreground">
          {localDateTime(row.updated_at, locale, false)}
        </DataTableCell>
        <DataTableCell lines="auto">
          <ActionMenu
            label={`${title}: ${t.chat.moreActions}`}
            items={actionItems({ id: row.id, title: row.title, active: session?.active === true })}
            trigger={<MoreHorizontal size={16} aria-hidden />}
            // Rename, branch, export and delete are reachable ONLY through this button, so it cannot be a
            // hover affordance. Touch and keyboard always reveal it; fine pointers keep the quiet row
            // treatment until hover, focus or Radix's open state.
            triggerClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          />
        </DataTableCell>
      </DataTableRow>
    );
  };

  /** One schedule, under the conversation it is filed in.
   *
   *  Following it opens the conversation its runs actually landed in, which is where a reader who clicks a
   *  job from a conversation list is going. Only where the daemon could not name that transcript — a job
   *  that has never fired, or one whose runs land somewhere this account may not read — does the row fall
   *  back to the schedule's own editor, which is what it always used to open. */
  const jobRow = (node: ConversationTreeNode, link: ConversationJobLink, last: boolean): ReactNode => {
    const label = scheduledJobName(link, t.scheduledJobs);
    const cellClass = 'flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-xs text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';
    const run = link.run;
    return (
      <DataTableRow key={`${node.row.id}:job:${link.jobId}`} id={jobRowDomId(node.row.id, link.jobId)} data-tree-row="job">
        {/* ONE cell across the whole row, so the branch is drawn from the register's left edge: a
            schedule hangs off the conversation above it and does not pretend to have a state, a model
            or a token total of its own.

            The flex lives on the CELL rather than on a wrapper inside it. The cell is a grid item and
            does stretch to the row, but a percentage height inside it resolves against `auto` and left
            the trunk as tall as its own text; `self-stretch` on the guide is what fills the row. */}
        <DataTableCell lines="auto" className="flex items-stretch gap-1.5 self-stretch" style={{ gridColumn: '1 / -1' }}>
          <TreeGuide last={last} />
          {run ? (
            <button
              type="button"
              onClick={() => { dismiss(); openBrainSession(run.sessionId, run.continuable); }}
              aria-label={label}
              className={cellClass}
            >
              <ScheduledJobLink link={link} labels={t.scheduledJobs} />
            </button>
          ) : (
            <Link href={link.href} onClick={dismiss} aria-label={label} className={cellClass}>
              <ScheduledJobLink link={link} labels={t.scheduledJobs} />
            </Link>
          )}
        </DataTableCell>
      </DataTableRow>
    );
  };

  const renderNode = (node: ConversationTreeNode): ReactNode[] => {
    const out: ReactNode[] = [conversationRow(node)];
    if (node.jobs.length > 0 && jobBranchOpen(node.row.id)) {
      node.jobs.forEach((link, i) => out.push(jobRow(node, link, i === node.jobs.length - 1)));
    }
    // The sub-agents that ran under this conversation, as their own collapsed group. Following one opens
    // its transcript READ-ONLY: a finished delegation is a record of what happened, not a chat to resume.
    out.push(...subagentBranchRows({
      conversation: { id: node.row.id, title: node.row.title || t.brainChat.untitled },
      nodes: subagents[node.row.id] ?? [],
      labels: subagentLabels,
      rowDomId: (suffix) => `${uid}-${encodeURIComponent(node.row.id)}-${suffix}`,
      indent: 0,
      open: openAgents.has(node.row.id),
      onToggleBranch: () => toggleIds(setOpenAgents, node.row.id),
      openKeys: openAgentNodes,
      onToggleNode: (key) => toggleIds(setOpenAgentNodes, key),
      forceOpen: false,
      onOpenSession: (sessionId) => { dismiss(); openBrainSession(sessionId, false); },
    }));
    return out;
  };

  // What an empty table says depends on WHY it is empty: a query that matched nothing is a different
  // answer from an account that has never chatted, and a search still in flight is neither.
  const emptyText = q.length >= 2
    ? (results === null ? null : t.brainChat.searchEmpty)
    : t.chat.emptyHistory;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {homeLink ? (
        <Link
          href="/dash"
          onClick={dismiss}
          className="flex items-center gap-2 border-b border-border px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={16} aria-hidden />
          <span className="truncate">{t.nav.dashboard}</span>
        </Link>
      ) : null}

      <ControlSurfaceToolbar testId="conversation-history-toolbar" layout="split">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-base font-semibold text-foreground">{t.sessionsPanel.viewMine}</h2>
          {visible.length > 0 ? <span className="font-mono text-xs text-muted-foreground">{visible.length}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RegisterSearch
            value={search}
            onChange={setSearch}
            label={t.brainChat.searchPlaceholder}
            placeholder={t.brainChat.searchPlaceholder}
            autoFocusInOverlay
          />
          <button
            type="button"
            onClick={() => openSession({ fresh: true })}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <Plus size={16} aria-hidden />
          </button>
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister className="flex min-h-0 flex-1 flex-col">
        {/* A failed read is said out loud, once. A cron plugin that is absent, disabled or not granted
            answers `unavailable` and shows nothing at all — but a read that FAILED must not be presented
            as "no conversation has a schedule". */}
        {jobsFailed ? <p role="status" className="px-1 pt-1 text-tiny text-muted-foreground">{t.scheduledJobs.error}</p> : null}
        {/* Same rule for the core branch: a failed read must not read as "nothing was delegated here". */}
        {subagentsFailed ? <p role="status" className="px-1 pt-1 text-tiny text-muted-foreground">{t.subagentBranch.error}</p> : null}
        <div ref={scrollRef} data-testid="conversation-history-scroll" className="min-h-0 flex-1 overflow-y-auto">
          {sessions.isLoading && !sessions.data ? null : visible.length === 0 ? (
            emptyText ? <p className="py-8 text-xs italic text-muted-foreground">{emptyText}</p> : null
          ) : (
            <DataTable
              ariaLabel={t.chat.historyTitle}
              columns={COLUMNS}
              compactColumns={COMPACT_COLUMNS}
              data-testid="conversation-history-list"
            >
              <DataTableRow header>
                {/* The state column shows a glyph and has no room for a word; its name is still announced. */}
                <DataTableSortCell active={sort === 'state'} direction={direction} onSort={() => sortBy('state')}>
                  <span className="sr-only">{t.sessionsPanel.colState}</span>
                </DataTableSortCell>
                <DataTableSortCell priority="wide" active={sort === 'model'} direction={direction} onSort={() => sortBy('model')}>{t.sessionsPanel.colModel}</DataTableSortCell>
                <DataTableSortCell active={sort === 'title'} direction={direction} onSort={() => sortBy('title')}>{t.sessionsPanel.colTitle}</DataTableSortCell>
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
        {visible.length > 0 ? (
          <Pager
            page={clampedPage}
            pageSize={pageSize}
            total={visible.length}
            onPageChange={setPage}
            ariaLabel={t.chat.historyTitle}
          />
        ) : null}
      </ControlSurfaceRegister>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t.brainChat.deleteChatConfirmTitle}
        description={deleteTarget ? t.brainChat.deleteChatConfirmDescription.replace('{title}', deleteTarget.title) : undefined}
        confirmLabel={t.brainChat.deleteChat}
        confirmDisabled={deletePending}
        onConfirm={confirmDelete}
        onClose={closeDelete}
      />
    </section>
  );
}
