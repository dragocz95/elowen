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
import type { ManagedSession } from '../../lib/types';

/** Compact token count: 1 234 → "1.2k", 980 → "980". */
function fmtTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** Right rail on the sessions page: EVERY brain session the operator anchors (web/CLI conversations +
 *  Discord channels + task workers) — a heading, then one row per session with its model icon, title and
 *  token count. Admin-only endpoint; a non-admin just gets an empty state. Delete on hover + delete-all. */
export function BrainSessionsPanel() {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const q = useQuery({ queryKey: ['brain-managed-sessions'], queryFn: () => orcaClient.brainManagedSessions() });
  const sessions = q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['brain-managed-sessions'] });

  const doDelete = async (id: string) => {
    setConfirmId(null);
    try { await orcaClient.brainDeleteManagedSession(id); await refresh(); toast(t.sessionsPanel.deleted, 'ok'); }
    catch { toast(t.common.error, 'error'); }
  };
  const doDeleteAll = async () => {
    setConfirmAll(false);
    try { const { deleted } = await orcaClient.brainDeleteAllManagedSessions(); await refresh(); toast(`${t.sessionsPanel.deletedAll} (${deleted})`, 'ok'); }
    catch { toast(t.common.error, 'error'); }
  };

  const kindIcon = (k: ManagedSession['kind']) => k === 'channel' ? Hash : k === 'task' ? Cpu : MessageSquare;

  return (
    <div className="flex flex-col gap-3">
      {/* Heading — mirrors the Account "default model" rail. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-text">
          <MessageSquare size={16} className="text-text-muted" aria-hidden />{t.sessionsPanel.tab}
          {sessions.length > 0 ? <span className="text-xs font-normal text-text-muted">{sessions.length}</span> : null}
        </span>
        {sessions.length > 0 ? (
          <button type="button" onClick={() => setConfirmAll(true)} className="text-tiny text-text-muted transition-colors hover:text-danger">
            {t.sessionsPanel.deleteAll}
          </button>
        ) : null}
      </div>

      {q.isLoading ? <p className="text-xs italic text-text-muted">{t.common.loading}</p>
        : q.isError ? <p className="text-xs italic text-text-muted">{t.common.daemonUnreachable}</p>
        : sessions.length === 0 ? <p className="text-xs italic text-text-muted">{t.sessionsPanel.empty}</p>
        : (
          <ul className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto pr-1">
            {sessions.map((s) => {
              const KindIcon = kindIcon(s.kind);
              return (
                <li key={s.id} className="group flex items-center gap-2.5 rounded-lg border border-border bg-elevated px-2.5 py-2">
                  <ModelIcon name={s.model} size={20} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-text">{s.title || t.sessionsPanel.untitled}</span>
                      {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                    </div>
                    <div className="flex items-center gap-1.5 text-tiny text-text-muted">
                      <KindIcon size={10} aria-hidden />
                      <span>{`${fmtTokens(s.tokens)} ${t.sessionsPanel.tok}`}</span>
                      <span>·</span>
                      <span className="truncate">{localDateTime(s.updated_at, locale, false)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmId(s.id)}
                    aria-label={t.common.delete}
                    title={t.common.delete}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

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
