'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Bot, X, Square, RotateCcw, MoreVertical, Eye, SquareTerminal } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useAdvisorStatus, useConfig, useMe, useSessionInfos } from '../../lib/queries';
import { useAdvisorStart, useAdvisorStop } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { apiErrorMessage } from '../../lib/orcaClient';
import { agentDisplayName } from '../../lib/agentUtils';
import type { DockPane } from '../../lib/useDockState';

// xterm references browser-only `self`; skip SSR so the docked panel doesn't break prerender.
// Real-PTY stream (read-write), with a snapshot fallback built in.
const Terminal = dynamic(() => import('../../components/terminal/StreamTerminal').then((m) => m.StreamTerminal), { ssr: false });

/** One pane in the docked advisor panel: either the user's own advisor (with start/stop lifecycle and
 *  agent picker) or a read-write terminal onto an arbitrary running session. */
export function AdvisorPane({ pane, onRemove }: { pane: DockPane; onRemove?: () => void }) {
  if (pane.kind === 'session') return <SessionPane name={pane.name!} onRemove={onRemove} />;
  return <AdvisorLifecyclePane />;
}

/** Compact pane header: a leading node, a title, optional trailing controls. */
function PaneHeader({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 border-b border-border px-3 py-2">{children}</div>;
}

function SessionPane({ name, onRemove }: { name: string; onRemove?: () => void }) {
  const { t } = useTranslation();
  const infos = useSessionInfos();
  const info = infos.data?.find((s) => s.name === name);
  const Icon = info?.role === 'overseer' ? Eye : info?.role === 'pilot' || info?.role === 'advisor' ? Bot : SquareTerminal;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader>
        <Icon size={15} className="text-text-muted" aria-hidden />
        <span className="truncate text-sm font-medium">{agentDisplayName(name)}</span>
        <div className="flex-1" />
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

function AdvisorLifecyclePane() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const status = useAdvisorStatus();
  const config = useConfig();
  const me = useMe();
  const start = useAdvisorStart();
  const stop = useAdvisorStop();

  const running = status.data?.running ?? false;
  const session = status.data?.session ?? null;

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
      </PaneHeader>

      <div className="min-h-0 flex-1">
        {running && session ? (
          <Terminal name={session} />
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
                        className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${on ? 'border-accent bg-accent/[0.08]' : 'border-border bg-bg hover:border-border-strong hover:bg-elevated'}`}
                      >
                        <span className="block font-medium">{m.label}</span>
                        <span className="block font-mono text-[11px] text-text-muted">{m.exec}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex-1" />
                <Button variant="accent" icon={Bot} onClick={() => doStart(chosen)} disabled={!chosen || start.isPending}>
                  {start.isPending ? t.advisor.starting : t.advisor.start}
                </Button>
                <p className="text-center text-[11px] text-text-muted">{t.advisor.hint}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
