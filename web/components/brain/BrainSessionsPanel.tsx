'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Circle, FileCode, FileJson, MoreHorizontal } from 'lucide-react';
import { elowenClient } from '../../lib/elowenClient';
import { openBrainSession } from '../../lib/brainDock';
import { localDateTime, formatTokens } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../ui/Toast';
import { useMe } from '../../lib/queries';
import { usePersistentState } from '../../lib/usePersistentState';
import { Avatar } from '../ui/Avatar';
import { ModelIcon } from '../ui/ModelIcon';
import { PlatformIcon } from '../ui/PlatformIcon';
import { Segmented } from '../ui/Segmented';
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

interface Row { id: string; title: string; model: string; updated_at: string; running: boolean; kind: 'conversation' | 'channel' | 'task'; tokens?: number; ownerId?: number; ownerLabel?: string; platform?: string | null; direct?: boolean; lastWriterId?: number | null; lastWriterLabel?: string | null }

/** Platforms that are MACHINE work rather than a place people talk: a delegated sub-agent and a scheduled
 *  run. The account that owns those really did start them, so they are never re-labelled as hosted. */
const MACHINE_PLATFORMS = new Set(['subagent', 'cron']);

/** Whether this row's owner merely HOSTS the transcript instead of being the person talking in it — a
 *  shared platform room, which core deliberately anchors on the instance operator because a room has no
 *  single author (see `direct` on ManagedSessionView). A direct 1:1 chat is genuinely its owner's. */
const hostedRoom = (s: Row): boolean =>
  s.kind === 'channel' && !!s.platform && !s.direct && !MACHINE_PLATFORMS.has(s.platform);

type SortKey = 'title' | 'owner' | 'model' | 'tokens' | 'updated';

/** The order a column takes when it is first clicked: text reads naturally A→Z, while a number and a
 *  timestamp are almost always wanted biggest/newest first. */
const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = { title: 'asc', owner: 'asc', model: 'asc', tokens: 'desc', updated: 'desc' };

// Model first, then the conversation, its owner, the tokens it burned and when it last moved.
const COLUMNS = 'minmax(0,1.2fr) minmax(0,2.4fr) minmax(0,1.2fr) 5.5rem 10rem 2.25rem';
const COMPACT_COLUMNS = 'minmax(0,1fr) 2.25rem';

/** Full-width conversation register. A regular user sees only their own conversations; an admin
 *  defaults to every user's oversight view and can switch to their own. `afterOpen` lets a modal host
 *  (the Chat page) dismiss itself once a row hands the conversation to the chat surface. */
export function BrainSessionsPanel({ afterOpen }: { afterOpen?: () => void } = {}) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const myId = me.data?.user?.id;
  const [adminView, setAdminView] = usePersistentState<'all' | 'mine'>('elowen.sessions.brainView', 'all', ['all', 'mine']);
  // A non-admin only ever has their own; the toggle applies to admins.
  const view: 'all' | 'mine' = isAdmin ? adminView : 'mine';
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

  // Accounts are read only to put a FACE on the owner column — the rows already carry the name. An
  // ordinary user never sees a foreign row, so the admin-only endpoint stays unasked for them.
  const users = useQuery({ queryKey: ['users'], queryFn: elowenClient.listUsers, enabled: isAdmin });
  const userById = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u])), [users.data]);
  const managed = useQuery({ queryKey: ['brain-managed-sessions'], queryFn: elowenClient.brainManagedSessions, enabled: isAdmin && view === 'all' });
  const own = useQuery({ queryKey: ['brain-sessions'], queryFn: elowenClient.brainSessions, enabled: view === 'mine' });
  const q = view === 'all' ? managed : own;
  // Own sessions carry no kind/tokens — they're always continuable conversations.
  const sessions: Row[] = view === 'all'
    ? (managed.data ?? [])
    : (own.data ?? []).map((s) => ({ ...s, kind: 'conversation' as const }));
  const needle = search.trim().toLowerCase();
  // The search covers the owner too, so narrowing to one person needs no separate filter control.
  const visible = sessions
    .filter((s) => !needle || `${s.title} ${s.ownerLabel ?? ''} ${s.model}`.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => {
      const flip = direction === 'asc' ? 1 : -1;
      switch (sort) {
        case 'title': return flip * a.title.localeCompare(b.title) || b.updated_at.localeCompare(a.updated_at);
        case 'owner': return flip * (a.ownerLabel ?? '').localeCompare(b.ownerLabel ?? '') || b.updated_at.localeCompare(a.updated_at);
        case 'model': return flip * a.model.localeCompare(b.model) || b.updated_at.localeCompare(a.updated_at);
        // Every sort falls back to recency, so rows with an equal key keep a stable, meaningful order.
        case 'tokens': return flip * ((a.tokens ?? 0) - (b.tokens ?? 0)) || b.updated_at.localeCompare(a.updated_at);
        default: return flip * a.updated_at.localeCompare(b.updated_at);
      }
    });
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

  useEffect(() => { setPage(0); }, [view, search, sort, direction]);

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
      const rowHeight = rows[1]?.getBoundingClientRect().height ?? FALLBACK_ROW_HEIGHT;
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

  const refresh = () => qc.invalidateQueries({ queryKey: view === 'all' ? ['brain-managed-sessions'] : ['brain-sessions'] });

  const doDelete = async (id: string) => {
    setConfirmId(null);
    try {
      if (view === 'all') await elowenClient.brainDeleteManagedSession(id);
      else await elowenClient.brainDeleteSession(id);
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
      // Delete what is on screen: the cross-account register wipes every account's history, the personal
      // view only the caller's. Sending one of them regardless would make the button lie in the other.
      const { deleted } = await elowenClient.brainDeleteAllManagedSessions(view === 'all' ? 'all' : undefined);
      await refresh();
      toast(`${t.sessionsPanel.deletedAll} (${deleted})`, 'ok');
    }
    catch { toast(t.common.error, 'error'); }
  };

  const rowActions = (session: Row) => [
    { label: t.sessionsPanel.exportHtml, icon: FileCode, onSelect: () => { void doExport(session.id, 'html'); } },
    { label: t.sessionsPanel.exportJsonl, icon: FileJson, onSelect: () => { void doExport(session.id, 'jsonl'); } },
    { label: t.common.delete, icon: Trash2, tone: 'danger' as const, onSelect: () => setConfirmId(session.id) },
  ];

  const openRowContextMenu = (event: React.MouseEvent, session: Row) => {
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

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ControlSurfaceToolbar testId="brain-sessions-toolbar" className="flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:justify-between">
        {/* The heading carries the count and the help affordance; the one-line description that used to
            sit under it said what the table already shows. */}
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-base font-semibold text-text">{t.sessionsPanel.tab}</h2>
          {visible.length > 0 ? <span className="font-mono text-xs text-text-muted">{visible.length}</span> : null}
          <HelpTip align="right">{t.help.sessionsPanel}</HelpTip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The shared register search. Its predecessor here was a hand-built field pinned at `w-44`,
              which could neither grow into a wide toolbar nor shrink out of the way of the view switch
              and the bulk-delete button on a narrow one. */}
          <RegisterSearch
            value={search}
            onChange={setSearch}
            label={t.sessionsPanel.searchLabel}
            placeholder={t.sessionsPanel.searchLabel}
          />
          {isAdmin ? (
            <Segmented
              size="sm"
              value={view}
              onChange={(v) => setAdminView(v as 'all' | 'mine')}
              aria-label={t.sessionsPanel.tab}
              options={[{ value: 'all', label: t.sessionsPanel.viewAll }, { value: 'mine', label: t.sessionsPanel.viewMine }]}
            />
          ) : null}
          {/* Admin-only, in BOTH views, and each deletes exactly what is listed under it — the endpoint is
              told which. It used to appear only over the personal list, because back then it could only
              ever delete the caller's own rows and above the register it would have deleted six of forty
              without saying so. Ordinary users have no bulk delete at all: nobody asked for one, and a
              non-admin must never be able to reach another account's history. */}
          {isAdmin && visible.length > 0 ? (
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmAll(true)}>{t.sessionsPanel.deleteAll}</Button>
          ) : null}
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-testid="brain-sessions-scroll" className="min-h-0 flex-1 overflow-y-auto">
      {q.isLoading ? <LoadingLine />
        : q.isError ? <p className="py-8 text-xs italic text-text-muted">{t.common.daemonUnreachable}</p>
        : visible.length === 0 ? <p className="py-8 text-xs italic text-text-muted">{sessions.length === 0 ? t.sessionsPanel.empty : t.sessionsPanel.noMatches}</p>
        : (
          <DataTable ariaLabel={t.sessionsPanel.tab} columns={COLUMNS} compactColumns={COMPACT_COLUMNS} data-testid="brain-sessions-list">
            <DataTableRow header>
              <DataTableSortCell priority="wide" active={sort === 'model'} direction={direction} onSort={() => sortBy('model')}>{t.sessionsPanel.colModel}</DataTableSortCell>
              <DataTableSortCell active={sort === 'title'} direction={direction} onSort={() => sortBy('title')}>{t.sessionsPanel.colTitle}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'owner'} direction={direction} onSort={() => sortBy('owner')}>{t.sessionsPanel.owner}</DataTableSortCell>
              <DataTableSortCell priority="wide" align="end" active={sort === 'tokens'} direction={direction} onSort={() => sortBy('tokens')}>{t.sessionsPanel.colTokens}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'updated'} direction={direction} onSort={() => sortBy('updated')}>{t.sessionsPanel.colUpdated}</DataTableSortCell>
              {/* The actions column has no name to print, but it is still a cell: `role="presentation"`
                  would leave a non-cell child inside role="row", which is invalid. */}
              <DataTableCell header lines={1}><span className="sr-only">{t.common.actions}</span></DataTableCell>
            </DataTableRow>
            {pageRows.map((s) => {
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
                <DataTableRow key={s.id} interactive className="group" onContextMenu={(event) => openRowContextMenu(event, s)}>
                  <DataTableCell priority="wide" lines={1}>
                    <span className="flex min-w-0 items-center gap-1.5" title={s.model}>
                      <ModelIcon name={s.model} size={14} />
                      <span className="truncate text-xs text-text-muted">{s.model}</span>
                    </span>
                  </DataTableCell>
                  {/* The title IS the row's control here, so the cell keeps its focus ring and its own
                      layout instead of being clipped; the label inside truncates on its own. */}
                  <DataTableCell lines="auto">
                    <button
                      type="button"
                      onClick={() => { openBrainSession(s.id, continuable); afterOpen?.(); }}
                      title={label}
                      aria-label={`${label}: ${title}`}
                      className="flex w-full min-w-0 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                    >
                      <span className="truncate text-sm text-text transition-colors group-hover:text-accent">{title}</span>
                      {/* WHERE the conversation happened. A web chat carries no mark — it is the norm
                          here and labelling every row would be noise. */}
                      {s.platform ? <PlatformIcon platform={s.platform} /> : null}
                      {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                    </button>
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
                        <span className="truncate text-xs text-text-muted">{s.lastWriterLabel}</span>
                        <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-tiny text-text-muted">{t.sessionsPanel.roomBadge}</span>
                      </span>
                    ) : owner ? (
                      <span className="flex min-w-0 items-center gap-2" title={s.ownerLabel ?? ''}>
                        <Avatar user={owner} size={20} />
                        <span className="truncate text-xs text-text-muted">{s.ownerLabel ?? ''}</span>
                        {hostedRoom(s) ? (
                          <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-tiny text-text-muted">{t.sessionsPanel.roomBadge}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </DataTableCell>
                  <DataTableCell priority="wide" lines={1} className="text-right font-mono text-tiny text-text-muted">
                    {s.tokens != null ? formatTokens(s.tokens) : ''}
                  </DataTableCell>
                  <DataTableCell priority="wide" lines={1} className="font-mono text-tiny text-text-muted">{localDateTime(s.updated_at, locale, false)}</DataTableCell>
                  <DataTableCell lines="auto">
                    <ActionMenu
                      label={`${title}: ${t.common.actions}`}
                      items={rowActions(s)}
                      trigger={<MoreHorizontal size={16} aria-hidden />}
                      triggerClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                    />
                  </DataTableCell>
                </DataTableRow>
              );
            })}
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
        onConfirm={() => confirmId && void doDelete(confirmId)}
        onClose={() => setConfirmId(null)}
      />
      {contextMenu ? <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} /> : null}
      <ConfirmDialog
        open={confirmAll}
        title={t.sessionsPanel.confirmDeleteAllTitle}
        // Wiping the whole team's history is a different act from clearing your own, so it says so.
        description={view === 'all' ? t.sessionsPanel.confirmDeleteAllEveryoneDesc : t.sessionsPanel.confirmDeleteAllDesc}
        confirmLabel={t.sessionsPanel.deleteAll}
        onConfirm={() => void doDeleteAll()}
        onClose={() => setConfirmAll(false)}
      />
    </section>
  );
}
