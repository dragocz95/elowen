'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, MessageSquare, Circle, FileCode, FileJson } from 'lucide-react';
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

/** Compact token count: 1 234 → "1.2k", 980 → "980". */
function fmtTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

interface Row { id: string; title: string; model: string; updated_at: string; running: boolean; kind: 'conversation' | 'channel' | 'task'; tokens?: number }

/** Right rail on the sessions page: brain conversations, model icon + title, clickable to open/continue
 *  in the web chat. A regular user sees ONLY their own conversations; an admin defaults to every user's
 *  (oversight) and can toggle to just their own. Delete on hover; delete-all only in the admin "all" view. */
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

  const managed = useQuery({ queryKey: ['brain-managed-sessions'], queryFn: elowenClient.brainManagedSessions, enabled: isAdmin && view === 'all' });
  const own = useQuery({ queryKey: ['brain-sessions'], queryFn: elowenClient.brainSessions, enabled: view === 'mine' });
  const q = view === 'all' ? managed : own;
  // Own sessions carry no kind/tokens — they're always continuable conversations.
  const sessions: Row[] = view === 'all'
    ? (managed.data ?? [])
    : (own.data ?? []).map((s) => ({ ...s, kind: 'conversation' as const }));

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
    <div className="flex flex-col gap-4">
      {/* Heading — mirrors the Account rail's "default model" header. The "?" explains the session types. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-text">
          <MessageSquare size={16} className="text-text-muted" aria-hidden />{t.sessionsPanel.tab}
          {sessions.length > 0 ? <span className="text-xs font-normal text-text-muted">{sessions.length}</span> : null}
          <HelpTip align="right">{t.help.sessionsPanel}</HelpTip>
        </span>
        {isAdmin && view === 'all' && sessions.length > 0 ? (
          <button type="button" onClick={() => setConfirmAll(true)} className="text-tiny text-text-muted transition-colors hover:text-danger">
            {t.sessionsPanel.deleteAll}
          </button>
        ) : null}
      </div>

      {/* Admins toggle between every user's conversations and just their own. */}
      {isAdmin ? (
        <Segmented
          size="sm"
          value={view}
          onChange={(v) => setAdminView(v as 'all' | 'mine')}
          aria-label={t.sessionsPanel.tab}
          options={[{ value: 'all', label: t.sessionsPanel.viewAll }, { value: 'mine', label: t.sessionsPanel.viewMine }]}
        />
      ) : null}

      {q.isLoading ? <p className="text-xs italic text-text-muted">{t.common.loading}</p>
        : q.isError ? <p className="text-xs italic text-text-muted">{t.common.daemonUnreachable}</p>
        : sessions.length === 0 ? <p className="text-xs italic text-text-muted">{t.sessionsPanel.empty}</p>
        : (
          <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1">
            {sessions.map((s) => {
              // Own conversations (web/CLI) resume & continue in the web chat; channel (Discord) and
              // task-worker sessions open read-only (the daemon won't let the owner post into them).
              const continuable = s.kind === 'conversation';
              const label = continuable ? t.sessionsPanel.openInChat : t.sessionsPanel.viewInChat;
              return (
              <div key={s.id} className="group flex items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-elevated">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
                  <ModelIcon name={s.model} size={28} />
                </span>
                <button
                  type="button"
                  onClick={() => openBrainSession(s.id, continuable)}
                  title={label}
                  aria-label={`${label}: ${s.title || t.sessionsPanel.untitled}`}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col text-left"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-text">{s.title || t.sessionsPanel.untitled}</span>
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
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:text-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <FileCode size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void doExport(s.id, 'jsonl')}
                  aria-label={t.sessionsPanel.exportJsonl}
                  title={t.sessionsPanel.exportJsonl}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:text-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <FileJson size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmId(s.id)}
                  aria-label={t.common.delete}
                  title={t.common.delete}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
              );
            })}
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
