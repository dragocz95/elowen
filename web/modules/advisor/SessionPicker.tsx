'use client';
import { Bot, Eye, SquareTerminal } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useSessionInfos } from '../../lib/queries';
import { agentDisplayName } from '../../lib/agentUtils';
import type { SessionInfo } from '../../lib/types';

function roleIcon(role: SessionInfo['role']) {
  return role === 'overseer' ? Eye : role === 'pilot' || role === 'advisor' ? Bot : SquareTerminal;
}

/** A small dropdown listing the live sessions a user can stack into the dock as a terminal pane,
 *  minus the ones already shown (`exclude`). Picking one calls `onPick(name)`. */
export function SessionPicker({ open, onPick, onClose, exclude }: {
  open: boolean;
  onPick: (name: string) => void;
  onClose: () => void;
  exclude: string[];
}) {
  const { t } = useTranslation();
  const infos = useSessionInfos();
  if (!open) return null;
  const excluded = new Set(exclude);
  const sessions = (infos.data ?? []).filter((s) => !excluded.has(s.name));

  return (
    <>
      {/* Click-away layer so the dropdown closes on an outside click. */}
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <div
        role="menu"
        className="absolute right-0 top-full z-50 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-xl"
      >
        <p className="px-2 py-1.5 text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.advisor.pickSession}</p>
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
                <span className="truncate">{agentDisplayName(s.name)}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
