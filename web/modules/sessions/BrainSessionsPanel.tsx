'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, MessageSquare, Circle, FileCode, FileJson, ChevronLeft, ChevronRight } from 'lucide-react';
import { elowenClient } from '../../lib/elowenClient';
import { openBrainSession } from '../../lib/brainDock';
import { localDateTime } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { useMe } from '../../lib/queries';
import { usePersistentState } from '../../lib/usePersistentState';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Segmented } from '../../components/ui/Segmented';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { Button } from '../../components/ui/Button';

const PAGE_SIZE = 12;

/** Compact token count: 1 234 → "1.2k", 980 → "980". */
function fmtTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

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

  return (
    <section className="flex min-w-0 flex-col">
      <div className="flex flex-col gap-3 border-b border-border/80 pb-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2 text-base font-semibold text-text">
            <MessageSquare size={16} className="text-text-muted" aria-hidden />
            <h2>{t.sessionsPanel.tab}</h2>
            {sessions.length > 0 ? <span className="font-mono text-xs font-normal text-text-muted">{sessions.length}</span> : null}
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
            <button type="button" onClick={() => setConfirmAll(true)} className="h-9 px-2 text-xs text-text-muted transition-colors hover:text-danger">
              {t.sessionsPanel.deleteAll}
            </button>
          ) : null}
        </div>
      </div>

      {q.isLoading ? <p className="py-8 text-xs italic text-text-muted">{t.common.loading}</p>
        : q.isError ? <p className="py-8 text-xs italic text-text-muted">{t.common.daemonUnreachable}</p>
        : sessions.length === 0 ? <p className="py-8 text-xs italic text-text-muted">{t.sessionsPanel.empty}</p>
        : (
          <div data-testid="brain-sessions-list" role="list" className="flex flex-col divide-y divide-border/80">
            {pageRows.map((s) => {
              // Own conversations (web/CLI) resume & continue in the web chat; channel (Discord) and
              // task-worker sessions open read-only (the daemon won't let the owner post into them).
              const continuable = s.kind === 'conversation';
              const label = continuable ? t.sessionsPanel.openInChat : t.sessionsPanel.viewInChat;
              return (
              <div key={s.id} role="listitem" className="group flex min-w-0 items-center gap-3 py-3 transition-colors hover:bg-white/[0.015]">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-elevated/70">
                  <ModelIcon name={s.model} size={24} />
                </span>
                <button
                  type="button"
                  onClick={() => openBrainSession(s.id, continuable)}
                  title={label}
                  aria-label={`${label}: ${s.title || t.sessionsPanel.untitled}`}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-text transition-colors group-hover:text-accent">{s.title || t.sessionsPanel.untitled}</span>
                    {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                  </span>
                  <span className="truncate font-mono text-tiny text-text-muted">
                    {s.tokens != null ? `${fmtTokens(s.tokens)} ${t.sessionsPanel.tok} · ` : ''}{localDateTime(s.updated_at, locale, false)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void doExport(s.id, 'html')}
                  aria-label={t.sessionsPanel.exportHtml}
                  title={t.sessionsPanel.exportHtml}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted opacity-0 transition-all hover:bg-elevated hover:text-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <FileCode size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void doExport(s.id, 'jsonl')}
                  aria-label={t.sessionsPanel.exportJsonl}
                  title={t.sessionsPanel.exportJsonl}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted opacity-0 transition-all hover:bg-elevated hover:text-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <FileJson size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmId(s.id)}
                  aria-label={t.common.delete}
                  title={t.common.delete}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
              );
            })}
          </div>
        )}

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

      <ConfirmDialog
        open={confirmId !== null}
        title={t.sessionsPanel.confirmDeleteTitle}
        description={t.sessionsPanel.confirmDeleteDesc}
        onConfirm={() => confirmId && void doDelete(confirmId)}
        onClose={() => setConfirmId(null)}
      />
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
