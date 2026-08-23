'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Circle, FileCode, FileJson, ChevronLeft, ChevronRight, MoreHorizontal, Search } from 'lucide-react';
import { elowenClient } from '../../lib/elowenClient';
import { openBrainSession } from '../../lib/brainDock';
import { localDateTime, formatTokens } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../ui/Toast';
import { useMe } from '../../lib/queries';
import { usePersistentState } from '../../lib/usePersistentState';
import { ModelIcon } from '../ui/ModelIcon';
import { Segmented } from '../ui/Segmented';
import { Input } from '../ui/Input';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { HelpTip } from '../ui/HelpTip';
import { Button } from '../ui/Button';
import { DataTable, DataTableCell, DataTableRow, DataTableSortCell, type SortDirection } from '../ui/DataTable';
import { ActionMenu } from '../ui/ActionMenu';
import { ContextMenu, type ContextMenuState } from '../ui/ContextMenu';
import { ControlSurfaceRegister, ControlSurfaceToolbar } from '../ui/ControlSurface';
import { LoadingLine } from '../ui/states';

const PAGE_SIZE = 12;

interface Row { id: string; title: string; model: string; updated_at: string; running: boolean; kind: 'conversation' | 'channel' | 'task'; tokens?: number; ownerId?: number; ownerLabel?: string }

type SortKey = 'title' | 'owner' | 'model' | 'tokens' | 'updated';

/** The order a column takes when it is first clicked: text reads naturally A→Z, while a number and a
 *  timestamp are almost always wanted biggest/newest first. */
const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = { title: 'asc', owner: 'asc', model: 'asc', tokens: 'desc', updated: 'desc' };

const COLUMNS = 'minmax(0,2.4fr) minmax(0,1fr) minmax(0,1.2fr) 5.5rem 10rem 2.25rem';
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
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [view, search, sort, direction]);

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
    try { const { deleted } = await elowenClient.brainDeleteAllManagedSessions(); await refresh(); toast(`${t.sessionsPanel.deletedAll} (${deleted})`, 'ok'); }
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
    <section className="flex min-w-0 flex-col">
      <ControlSurfaceToolbar testId="brain-sessions-toolbar" className="flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-base font-semibold text-text">{t.sessionsPanel.tab}</h2>
            {visible.length > 0 ? <span className="font-mono text-xs text-text-muted">{visible.length}</span> : null}
            <HelpTip align="right">{t.help.sessionsPanel}</HelpTip>
          </div>
          <p className="text-xs text-text-muted">{t.sessionsPanel.hint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex items-center">
            <Search size={14} className="pointer-events-none absolute left-2 text-text-muted" aria-hidden />
            <Input
              aria-label={t.sessionsPanel.searchLabel}
              placeholder={t.sessionsPanel.searchLabel}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-44 pl-7"
            />
          </label>
          {isAdmin ? (
            <Segmented
              size="sm"
              value={view}
              onChange={(v) => setAdminView(v as 'all' | 'mine')}
              aria-label={t.sessionsPanel.tab}
              options={[{ value: 'all', label: t.sessionsPanel.viewAll }, { value: 'mine', label: t.sessionsPanel.viewMine }]}
            />
          ) : null}
          {/* Owner-scoped by design: the endpoint deletes only the caller's conversations, so the button
              belongs over the caller's OWN list. Above the cross-account view it would read as deleting
              the team's history and then quietly delete six rows out of forty. */}
          {isAdmin && view === 'mine' && visible.length > 0 ? (
            <button type="button" onClick={() => setConfirmAll(true)} className="spatial-inline-action h-9 px-2 hover:!text-danger">
              <Trash2 size={14} aria-hidden />{t.sessionsPanel.deleteAll}
            </button>
          ) : null}
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister>
      {q.isLoading ? <LoadingLine />
        : q.isError ? <p className="py-8 text-xs italic text-text-muted">{t.common.daemonUnreachable}</p>
        : visible.length === 0 ? <p className="py-8 text-xs italic text-text-muted">{sessions.length === 0 ? t.sessionsPanel.empty : t.sessionsPanel.noMatches}</p>
        : (
          <DataTable ariaLabel={t.sessionsPanel.tab} columns={COLUMNS} compactColumns={COMPACT_COLUMNS} data-testid="brain-sessions-list">
            <DataTableRow header>
              <DataTableSortCell active={sort === 'title'} direction={direction} onSort={() => sortBy('title')}>{t.sessionsPanel.colTitle}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'owner'} direction={direction} onSort={() => sortBy('owner')}>{t.sessionsPanel.owner}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'model'} direction={direction} onSort={() => sortBy('model')}>{t.sessionsPanel.colModel}</DataTableSortCell>
              <DataTableSortCell priority="wide" align="end" active={sort === 'tokens'} direction={direction} onSort={() => sortBy('tokens')}>{t.sessionsPanel.colTokens}</DataTableSortCell>
              <DataTableSortCell priority="wide" active={sort === 'updated'} direction={direction} onSort={() => sortBy('updated')}>{t.sessionsPanel.colUpdated}</DataTableSortCell>
              {/* The actions column has no name to print, but it is still a cell: `role="presentation"`
                  would leave a non-cell child inside role="row", which is invalid. */}
              <DataTableCell header><span className="sr-only">{t.common.actions}</span></DataTableCell>
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
              return (
                <DataTableRow key={s.id} interactive className="group" onContextMenu={(event) => openRowContextMenu(event, s)}>
                  <DataTableCell>
                    <button
                      type="button"
                      onClick={() => { openBrainSession(s.id, continuable); afterOpen?.(); }}
                      title={label}
                      aria-label={`${label}: ${title}`}
                      className="flex w-full min-w-0 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                    >
                      <span className="truncate text-sm text-text transition-colors group-hover:text-accent">{title}</span>
                      {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                    </button>
                  </DataTableCell>
                  <DataTableCell priority="wide" className="truncate text-xs text-text-muted" title={s.ownerLabel ?? ''}>{s.ownerLabel ?? ''}</DataTableCell>
                  <DataTableCell priority="wide">
                    <span className="flex min-w-0 items-center gap-1.5" title={s.model}>
                      <ModelIcon name={s.model} size={12} />
                      <span className="truncate text-xs text-text-muted">{s.model}</span>
                    </span>
                  </DataTableCell>
                  <DataTableCell priority="wide" className="text-right font-mono text-tiny text-text-muted">
                    {s.tokens != null ? formatTokens(s.tokens) : ''}
                  </DataTableCell>
                  <DataTableCell priority="wide" className="font-mono text-tiny text-text-muted">{localDateTime(s.updated_at, locale, false)}</DataTableCell>
                  <DataTableCell>
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

      {/* Inside the register so the pager shares the card's horizontal inset (it used to sit as a
          sibling and hug the card edge). */}
      {visible.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/80 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-mono text-xs text-text-muted">
            {t.sessionsPanel.pageRange
              .replace('{from}', String(clampedPage * PAGE_SIZE + 1))
              .replace('{to}', String(clampedPage * PAGE_SIZE + pageRows.length))
              .replace('{total}', String(visible.length))}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" icon={ChevronLeft} disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>{t.calendar.previous}</Button>
            <span className="min-w-24 text-center font-mono text-xs text-text-muted">
              {t.sessionsPanel.pageLabel.replace('{page}', String(clampedPage + 1)).replace('{pages}', String(pageCount))}
            </span>
            <Button variant="ghost" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t.calendar.next}<ChevronRight size={15} className="ml-1" aria-hidden /></Button>
          </div>
        </div>
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
        description={t.sessionsPanel.confirmDeleteAllDesc}
        confirmLabel={t.sessionsPanel.deleteAll}
        onConfirm={() => void doDeleteAll()}
        onClose={() => setConfirmAll(false)}
      />
    </section>
  );
}
