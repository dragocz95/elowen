'use client';
import { SquareArrowOutUpRight } from 'lucide-react';
import { StreamTerminal } from './StreamTerminal';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { useKillSession } from '../../lib/mutations';
import { useToast } from '../ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { openTerminalWindow } from '../../lib/openTerminalWindow';
import { agentDisplayName } from '../../lib/agentUtils';

/** The full agent terminal: a single interactive xterm the user types directly into (all keys work),
 *  plus a slim footer carrying only the Kill action. There is no separate input box or key-button bar
 *  any more — keystrokes flow straight to the pane via xterm `onData`. */
export function TerminalPanel({ name, onKilled }: { name: string; onKilled?: () => void }) {
  const kill = useKillSession();
  const { toast } = useToast();
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <StreamTerminal name={name} />
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
        <div className="ml-auto flex items-center gap-2">
          <IconButton icon={SquareArrowOutUpRight} label={t.sessions.popOut} onClick={() => openTerminalWindow(name)} />
          <Button
            variant="danger"
            disabled={kill.isPending}
            onClick={() => kill.mutate(name, {
              onSuccess: () => { toast(t.sessions.killed.replace('{name}', agentDisplayName(name))); onKilled?.(); },
              onError: (e) => toast(String(e), 'error'),
            })}
          >
            {t.common.kill}
          </Button>
        </div>
      </div>
    </div>
  );
}
