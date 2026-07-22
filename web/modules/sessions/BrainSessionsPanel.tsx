'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Circle, FileCode, FileJson, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { elowenClient } from '../../lib/elowenClient';
import { openBrainSession } from '../../lib/brainDock';
import { localDateTime, formatTokens } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { useMe } from '../../lib/queries';
import { usePersistentState } from '../../lib/usePersistentState';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Segmented } from '../../components/ui/Segmented';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { Button } from '../../components/ui/Button';
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ContextMenu, type ContextMenuState } from '../../components/ui/ContextMenu';
import { ControlSurfaceRegister, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';

const PAGE_SIZE = 12;

interface Row { id: string; title: string; model: string; updated_at: string; running: boolean; kind: 'conversation' | 'channel' | 'task'; tokens?: number }

/** Full-width conversation register. A regular user sees only their own conversations; an admin
 *  defaults to every user's oversight view and can switch to their own. */
export function BrainSessionsPanel() {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const [adminView, setAdminView] = usePersistentState<'all' | 'mine'>('elowen.sessions.brainView', 'all', ['all', 'mine']);
  // A non-admin only ever has their own; the toggle applies to admins.
  const view: 'all' | 'mine' = isAdmin ? adminView : 'mine';
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [page, setPage] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const managed = useQuery({ queryKey: ['brain-managed-sessions'], queryFn: elowenClient.brainManagedSessions, enabled: isAdmin && view === 'all' });
  const own = useQuery({ queryKey: ['brain-sessions'], queryFn: elowenClient.brainSessions, enabled: view === 'mine' });
  const q = view === 'all' ? managed : own;
  // Own sessions carry no kind/tokens — they're always continuable conversations.
  const sessions: Row[] = view === 'all'
    ? (managed.data ?? [])
    : (own.data ?? []).map((s) => ({ ...s, kind: 'conversation' as const }));
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = sessions.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [view]);

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
            {sessions.length > 0 ? <span className="font-mono text-xs text-text-muted">{sessions.length}</span> : null}
            <HelpTip align="right">{t.help.sessionsPanel}</HelpTip>
          </div>
          <p className="text-xs text-text-muted">{t.sessionsPanel.hint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Segmented
              size="sm"
              value={view}
              onChange={(v) => setAdminView(v as 'all' | 'mine')}
              aria-label={t.sessionsPanel.tab}
              options={[{ value: 'all', label: t.sessionsPanel.viewAll }, { value: 'mine', label: t.sessionsPanel.viewMine }]}
            />
          ) : null}
          {isAdmin && view === 'all' && sessions.length > 0 ? (
            <button type="button" onClick={() => setConfirmAll(true)} className="spatial-inline-action h-9 px-2 hover:!text-danger">
              <Trash2 size={14} aria-hidden />{t.sessionsPanel.deleteAll}
            </button>
          ) : null}
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister>
      {q.isLoading ? <p className="py-8 text-xs italic text-text-muted">{t.common.loading}</p>
        : q.isError ? <p className="py-8 text-xs italic text-text-muted">{t.common.daemonUnreachable}</p>
        : sessions.length === 0 ? <p className="py-8 text-xs italic text-text-muted">{t.sessionsPanel.empty}</p>
        : (
          <EntityList data-testid="brain-sessions-list">
            <MotionPresence>
              {pageRows.map((s) => {
                // Own conversations (web/CLI) resume & continue in the web chat; channel (Discord) and
                // task-worker sessions open read-only (the daemon won't let the owner post into them).
                const continuable = s.kind === 'conversation';
                const label = continuable ? t.sessionsPanel.openInChat : t.sessionsPanel.viewInChat;
                const title = s.title || t.sessionsPanel.untitled;
                return (
                  <MotionLayoutItem key={s.id} layoutId={`brain-session-${s.id}`} role="listitem">
                    <EntityRow role="presentation" className="group" onContextMenu={(event) => openRowContextMenu(event, s)}>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-elevated/70">
                          <ModelIcon name={s.model} size={24} />
                        </span>
                        <button
                          type="button"
                          onClick={() => openBrainSession(s.id, continuable)}
                          title={label}
                          aria-label={`${label}: ${title}`}
                          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-text transition-colors group-hover:text-accent">{title}</span>
                            {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                          </span>
                          <span className="truncate font-mono text-tiny text-text-muted">
                            {s.tokens != null ? `${formatTokens(s.tokens)} ${t.sessionsPanel.tok} · ` : ''}{localDateTime(s.updated_at, locale, false)}
                          </span>
                        </button>
                        <ActionMenu
                          label={`${title}: ${t.common.actions}`}
                          items={rowActions(s)}
                          trigger={<MoreHorizontal size={16} aria-hidden />}
                          triggerClassName="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                        />
                      </div>
                    </EntityRow>
                  </MotionLayoutItem>
                );
              })}
            </MotionPresence>
          </EntityList>
        )}

      {/* Inside the register so the pager shares the card's horizontal inset (it used to sit as a
          sibling and hug the card edge). */}
      {sessions.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/80 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-mono text-xs text-text-muted">
            {t.sessionsPanel.pageRange
              .replace('{from}', String(clampedPage * PAGE_SIZE + 1))
              .replace('{to}', String(clampedPage * PAGE_SIZE + pageRows.length))
              .replace('{total}', String(sessions.length))}
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
