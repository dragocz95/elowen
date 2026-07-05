'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, MessageSquare, Circle } from 'lucide-react';
import { orcaClient } from '../../lib/orcaClient';
import { localDateTime } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';

/** Compact token count: 1 234 → "1.2k", 980 → "980". */
function fmtTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** Right rail on the sessions page — mirrors the Account "default model" column: a heading, then one
 *  card per brain session the operator anchors (web/CLI conversations + Discord channels + task workers)
 *  with the same large-icon card style, showing model icon, title and token count. Delete on hover +
 *  delete-all. Admin-only endpoint; a non-admin just gets an empty state. */
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

  return (
    <div className="flex flex-col gap-4">
      {/* Heading — mirrors the Account rail's "default model" header. The "?" explains the session types. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-text">
          <MessageSquare size={16} className="text-text-muted" aria-hidden />{t.sessionsPanel.tab}
          {sessions.length > 0 ? <span className="text-xs font-normal text-text-muted">{sessions.length}</span> : null}
          <HelpTip align="right">{t.help.sessionsPanel}</HelpTip>
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
          <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1">
            {sessions.map((s) => (
              <div key={s.id} className="group flex items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-elevated">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
                  <ModelIcon name={s.model} size={28} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-text">{s.title || t.sessionsPanel.untitled}</span>
                    {s.running ? <Circle size={7} className="shrink-0 fill-success text-success" aria-label={t.sessionsPanel.running} /> : null}
                  </span>
                  <span className="truncate font-mono text-tiny text-text-muted">
                    {`${fmtTokens(s.tokens)} ${t.sessionsPanel.tok} · ${localDateTime(s.updated_at, locale, false)}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmId(s.id)}
                  aria-label={t.common.delete}
                  title={t.common.delete}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            ))}
          </div>
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
