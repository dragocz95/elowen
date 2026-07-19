'use client';
import { Bot, Eye, SquareTerminal, MessagesSquare, Plus } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useMe, useSessionInfos, useTasks } from '../../lib/queries';
import { useOpenBrainTerminal } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/elowenClient';
import { useToast } from '../../components/ui/Toast';
import { sessionLabel } from '../../lib/agentUtils';
import { useBrainChat } from './BrainChatProvider';
import type { SessionInfo } from '../../lib/types';

function roleIcon(role: SessionInfo['role']) {
  return role === 'overseer' ? Eye : role === 'pilot' || role === 'advisor' ? Bot : role === 'chat' ? MessagesSquare : SquareTerminal;
}

/** A small dropdown listing the live sessions a user can stack into the dock as a terminal pane,
 *  minus the ones already shown (`exclude`). Picking one calls `onPick(name)`. Admins additionally get
 *  an "Elowen CLI" section that opens a real `elowen chat` terminal bound to the active brain conversation
 *  (the single source of truth: the one BrainChatProvider). */
export function SessionPicker({ open, onPick, onClose, exclude, showAdvisor, onAddAdvisor }: {
  open: boolean;
  onPick: (name: string) => void;
  onClose: () => void;
  exclude: string[];
  /** Whether to offer re-adding the advisor pane (it's been removed from the dock). */
  showAdvisor?: boolean;
  onAddAdvisor?: () => void;
}) {
  const { t } = useTranslation();
  const me = useMe();
  const infos = useSessionInfos();
  const tasks = useTasks();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const { activeSessionId, currentModel } = useBrainChat();
  const openTerminal = useOpenBrainTerminal();
  const { toast } = useToast();
  if (!open) return null;
  const excluded = new Set(exclude);
  const sessions = (infos.data ?? []).filter((s) => !excluded.has(s.name));

  const openElowenCli = () => {
    if (!activeSessionId) return;
    openTerminal.mutate(activeSessionId, {
      onSuccess: (r) => { onPick(r.terminal); onClose(); },
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
  };

  return (
    <>
      {/* Click-away layer so the dropdown closes on an outside click. */}
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <div
        role="menu"
        className="absolute right-0 top-full z-50 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-xl"
      >
        {isAdmin ? (
          <>
            <p className="px-2 py-1.5 text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.advisor.sectionElowenCli}</p>
            {activeSessionId ? (
              <button
                type="button"
                role="menuitem"
                onClick={openElowenCli}
                disabled={openTerminal.isPending}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface disabled:opacity-50"
              >
                <MessagesSquare size={15} className="shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.advisor.elowenCliOpen}</span>
                  {currentModel ? <span className="block truncate font-mono text-tiny text-text-muted">{currentModel}</span> : null}
                </span>
              </button>
            ) : (
              <p className="px-2 py-2 text-xs text-text-muted">{t.advisor.elowenCliNoSession}</p>
            )}
            <div className="my-1 border-t border-border" />
          </>
        ) : null}
        {showAdvisor && onAddAdvisor ? (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onAddAdvisor(); onClose(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface"
            >
              <Plus size={15} className="shrink-0 text-accent" aria-hidden />
              <span className="truncate">{t.advisor.addAdvisor}</span>
            </button>
            <div className="my-1 border-t border-border" />
          </>
        ) : null}
        <p className="px-2 py-1.5 text-tiny font-semibold uppercase tracking-wide text-text-muted">{isAdmin ? t.advisor.sectionCliAgents : t.advisor.pickSession}</p>
        {sessions.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-muted">{t.advisor.noSessions}</p>
        ) : (
          sessions.map((s) => {
            const Icon = roleIcon(s.role);
            return (
              <button
                key={s.name}
                type="button"
                role="menuitem"
                onClick={() => { onPick(s.name); onClose(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface"
              >
                <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
                <span className="truncate">{sessionLabel(s, tasks.data ?? [])}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
