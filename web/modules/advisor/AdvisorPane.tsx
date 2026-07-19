'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Bot, BotOff, X, Square, RotateCcw, MoreVertical, Eye, SquareTerminal, MessagesSquare, SquareArrowOutUpRight, Power } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useAdvisorStatus, useConfig, useMe, useSessionInfos, useTasks } from '../../lib/queries';
import { useAdvisorStart, useAdvisorStop, useKillSession } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { apiErrorMessage } from '../../lib/elowenClient';
import { sessionLabel } from '../../lib/agentUtils';
import { openTerminalWindow } from '../../lib/openTerminalWindow';
import { ModelIcon } from '../../components/ui/ModelIcon';
import type { DockPane } from '../../lib/useDockState';

// xterm references browser-only `self`; skip SSR so the docked panel doesn't break prerender.
// Real-PTY stream (read-write), with a snapshot fallback built in.
const Terminal = dynamic(() => import('../../components/terminal/StreamTerminal').then((m) => m.StreamTerminal), { ssr: false });

/** One pane in the docked advisor panel: either the user's own advisor (with start/stop lifecycle and
 *  agent picker) or a read-write terminal onto an arbitrary running session. */
export function AdvisorPane({ pane, onRemove }: { pane: DockPane; onRemove?: () => void }) {
  if (pane.kind === 'session') return <SessionPane name={pane.name!} onRemove={onRemove} />;
  return <AdvisorLifecyclePane onRemove={onRemove} />;
}

/** Compact pane header: a leading node, a title, optional trailing controls. */
function PaneHeader({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 border-b border-border px-3 py-2">{children}</div>;
}

function SessionPane({ name, onRemove }: { name: string; onRemove?: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const infos = useSessionInfos();
  const tasks = useTasks();
  const kill = useKillSession();
  const info = infos.data?.find((s) => s.name === name);
  const isChat = info?.role === 'chat';
  const Icon = info?.role === 'overseer' ? Eye : info?.role === 'pilot' || info?.role === 'advisor' ? Bot : isChat ? MessagesSquare : SquareTerminal;
  const label = sessionLabel(info ?? { name, role: 'agent' }, tasks.data ?? []);
  // Chat terminals get an explicit Stop (kill tmux + revoke token) on top of detach — a killed pane is
  // then detached from the dock. Arbitrary agent/task terminals stay detach-only.
  const doStop = () => kill.mutate(name, { onSuccess: () => onRemove?.(), onError: (e) => toast(apiErrorMessage(e), 'error') });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader>
        <Icon size={15} className="text-text-muted" aria-hidden />
        <span className="truncate text-sm font-medium">{label}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => openTerminalWindow(name)}
          aria-label={t.sessions.popOut}
          title={t.sessions.popOut}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <SquareArrowOutUpRight size={15} aria-hidden />
        </button>
        {isChat ? (
          <button
            type="button"
            onClick={doStop}
            disabled={kill.isPending}
            aria-label={t.advisor.stopTerminal}
            title={t.advisor.stopTerminal}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
          >
            <Square size={15} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t.advisor.removePane}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <X size={16} aria-hidden />
        </button>
      </PaneHeader>
      <div className="min-h-0 flex-1">
        <Terminal name={name} />
      </div>
    </div>
  );
}

function AdvisorLifecyclePane({ onRemove }: { onRemove?: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const status = useAdvisorStatus();
  const config = useConfig();
  const me = useMe();
  const start = useAdvisorStart();
  const stop = useAdvisorStop();

  const running = status.data?.running ?? false;
  const session = status.data?.session ?? null;
  // Whether the user wants an advisor at all. Off (autostart false, not running) collapses the pane to a
  // compact "turn it on" card instead of pushing the model picker on someone who only wants agent panes.
  const autostart = status.data?.autostart ?? false;
  const [picking, setPicking] = useState(false);

  // Models the user may run an advisor as: their admin allow-list, or all globally-allowed when they
  // have no per-user restriction — intersected with the global allow-list either way.
  const u = me.data?.user;
  const globalAllowed = config.data?.allowedExecs ?? [];
  const restricted = (u?.allowed_execs.length ?? 0) > 0;
  const allowedSet = new Set(restricted ? u!.allowed_execs : globalAllowed);
  const models = allModels(config.data?.customModels ?? [], config.data?.hiddenPresets ?? []).filter((m) => allowedSet.has(m.exec));
  const [selected, setSelected] = useState('');
  const chosen = selected || status.data?.exec || models[0]?.exec || '';

  const doStart = (exec: string) => start.mutate(exec, {
    onSuccess: () => toast(t.advisor.started),
    onError: (e) => toast(apiErrorMessage(e), 'error'),
  });
  const doStop = () => stop.mutate(undefined, {
    onSuccess: () => toast(t.advisor.stopped),
    onError: (e) => toast(apiErrorMessage(e), 'error'),
  });
  // "Run without an assistant": persist the off intent (stop disables autostart) and collapse the picker.
  const doDisable = () => stop.mutate(undefined, {
    onSuccess: () => { setPicking(false); toast(t.advisor.stopped); },
    onError: (e) => toast(apiErrorMessage(e), 'error'),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader>
        <Bot size={15} className="text-accent" aria-hidden />
        <span className="text-sm font-semibold">{t.advisor.title}</span>
        <span className={`ml-1 inline-flex items-center gap-1 text-xs ${running ? 'text-green-500' : 'text-text-muted'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-green-500' : 'bg-text-muted'}`} aria-hidden />
          {running ? t.advisor.running : t.advisor.idle}
        </span>
        <div className="flex-1" />
        {running && session ? (
          <button
            type="button"
            onClick={() => openTerminalWindow(session)}
            aria-label={t.sessions.popOut}
            title={t.sessions.popOut}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <SquareArrowOutUpRight size={15} aria-hidden />
          </button>
        ) : null}
        {running ? (
          <ActionMenu
            label={t.common.actions}
            align="right"
            triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
            trigger={<MoreVertical size={16} aria-hidden />}
            items={[
              { label: t.advisor.restart, icon: RotateCcw, onSelect: () => { stop.mutate(undefined, { onSuccess: () => doStart(chosen) }); } },
              { label: t.advisor.stop, icon: Square, tone: 'danger', onSelect: doStop },
            ]}
          />
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t.advisor.removePane}
            title={t.advisor.removePane}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <X size={16} aria-hidden />
          </button>
        ) : null}
      </PaneHeader>

      <div className="min-h-0 flex-1">
        {running && session ? (
          <Terminal name={session} />
        ) : !autostart && !picking ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <BotOff size={28} className="text-text-muted" aria-hidden />
            <p className="text-sm font-medium">{t.advisor.offTitle}</p>
            <p className="max-w-[16rem] text-xs text-text-muted">{t.advisor.offHint}</p>
            <Button variant="accent" icon={Power} onClick={() => setPicking(true)}>{t.advisor.enable}</Button>
          </div>
        ) : (
          <div className="flex h-full flex-col gap-4 p-5">
            {models.length === 0 ? (
              <p className="text-sm text-text-muted">{t.advisor.noExecs}</p>
            ) : (
              <>
                <p className="text-sm text-text-muted">{t.advisor.pickAgent}</p>
                <div className="grid grid-cols-2 gap-2">
                  {models.map((m) => {
                    const on = chosen === m.exec;
                    return (
                      <button
                        key={m.exec}
                        type="button"
                        onClick={() => setSelected(m.exec)}
                        aria-pressed={on}
                        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${on ? 'border-accent bg-accent/[0.08]' : 'border-border bg-bg hover:border-border-strong hover:bg-elevated'}`}
                      >
                        <ModelIcon name={m.exec} size={20} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{m.label}</span>
                          <span className="block truncate font-mono text-[11px] text-text-muted">{m.exec}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex-1" />
                <Button variant="accent" icon={Bot} onClick={() => doStart(chosen)} disabled={!chosen || start.isPending}>
                  {start.isPending ? t.advisor.starting : t.advisor.start}
                </Button>
                <button
                  type="button"
                  onClick={doDisable}
                  disabled={stop.isPending}
                  className="text-center text-[11px] text-text-muted underline-offset-2 transition-colors hover:text-text hover:underline disabled:opacity-50"
                >
                  {t.advisor.runWithout}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
