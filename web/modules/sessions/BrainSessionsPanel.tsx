'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, MessageSquare, Hash, Cpu, Circle } from 'lucide-react';
import { orcaClient } from '../../lib/orcaClient';
import { localDateTime } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import type { ManagedSession } from '../../lib/types';

const PAGE_SIZE = 15;

/** Admin panel: EVERY brain session the operator anchors — their own conversations plus the Discord
 *  channel sessions and task-worker sessions — with a model icon, delete, delete-all and pagination.
 *  Reads GET /brain/managed-sessions (admin-only); a non-admin simply sees an empty/forbidden state. */
export function BrainSessionsPanel() {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const q = useQuery({ queryKey: ['brain-managed-sessions'], queryFn: () => orcaClient.brainManagedSessions() });
  const sessions = q.data ?? [];
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const shown = sessions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const refresh = () => qc.invalidateQueries({ queryKey: ['brain-managed-sessions'] });

  const doDelete = async (id: string) => {
    setConfirmId(null);
    try { await orcaClient.brainDeleteManagedSession(id); await refresh(); toast(t.sessionsPanel.deleted, 'ok'); }
    catch { toast(t.common.error, 'error'); }
  };
  const doDeleteAll = async () => {
    setConfirmAll(false);
    try { const { deleted } = await orcaClient.brainDeleteAllManagedSessions(); await refresh(); setPage(0); toast(`${t.sessionsPanel.deletedAll} (${deleted})`, 'ok'); }
    catch { toast(t.common.error, 'error'); }
  };

  const kindIcon = (k: ManagedSession['kind']) => k === 'channel' ? Hash : k === 'task' ? Cpu : MessageSquare;
  const kindLabel = (k: ManagedSession['kind']) => k === 'channel' ? t.sessionsPanel.kindChannel : k === 'task' ? t.sessionsPanel.kindTask : t.sessionsPanel.kindConversation;

  if (q.isLoading) return <LoadingState variant="cards" />;
  if (q.isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => q.refetch()} />;
  if (sessions.length === 0) return <EmptyState title={t.sessionsPanel.empty} description={t.sessionsPanel.emptyDescription} icon={MessageSquare} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted">{t.sessionsPanel.total.replace('{n}', String(sessions.length))}</span>
        <Button variant="danger" icon={Trash2} onClick={() => setConfirmAll(true)}>{t.sessionsPanel.deleteAll}</Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {shown.map((s) => {
          const KindIcon = kindIcon(s.kind);
          return (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2">
              <ModelIcon name={s.model} size={22} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-text">{s.title || t.sessionsPanel.untitled}</span>
                  {s.running ? <Circle size={8} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                </div>
                <div className="flex items-center gap-2 text-tiny text-text-muted">
                  <KindIcon size={11} aria-hidden />
                  <span>{kindLabel(s.kind)}</span>
                  <span>·</span>
                  <span className="truncate font-mono opacity-70">{s.model || '—'}</span>
                  <span>·</span>
                  <span title={localDateTime(s.updated_at, locale)}>{localDateTime(s.updated_at, locale, false)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConfirmId(s.id)}
                aria-label={t.common.delete}
                title={t.common.delete}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:border-danger hover:text-danger"
              >
                <Trash2 size={15} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      {pageCount > 1 ? (
        <div className="flex items-center justify-center gap-3 pt-1 text-sm">
          <Button variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>{t.sessionsPanel.prev}</Button>
          <span className="tabular-nums text-text-muted">{page + 1} / {pageCount}</span>
          <Button variant="ghost" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>{t.sessionsPanel.next}</Button>
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
    </div>
  );
}
