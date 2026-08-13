import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TerminalSquare, SquareSlash, Power, SquareTerminal, Eye, Bot, MoreHorizontal } from 'lucide-react';
import { runtime, Link, type SessionInfo, type ContextMenuState } from '../runtime';

/** The pilot/overseer execs from the plugin's own config slice (config wave 2 — no longer on the
 *  public /config autopilot view). Fetched once per bundle load and shared by every card; the detail
 *  endpoint is admin-only, so a non-admin simply loses the model pill on the autopilot's own
 *  reasoning agents (worker pills come from the task exec and are unaffected). */
let execsPromise: Promise<{ pilotExec?: string; overseerExec?: string }> | null = null;
function useAgentsExecs(): { pilotExec?: string; overseerExec?: string } {
  const { api } = runtime();
  const [v, setV] = useState<{ pilotExec?: string; overseerExec?: string }>({});
  useEffect(() => {
    execsPromise ??= api('/plugins/agents')
      .then((d) => {
        const cfg = (d as { config?: { pilotExec?: unknown; overseerExec?: unknown } }).config ?? {};
        return {
          pilotExec: typeof cfg.pilotExec === 'string' ? cfg.pilotExec : undefined,
          overseerExec: typeof cfg.overseerExec === 'string' ? cfg.overseerExec : undefined,
        };
      })
      .catch(() => ({}));
    let alive = true;
    void execsPromise.then((c) => { if (alive) setV(c); });
    return () => { alive = false; };
  }, [api]);
  return v;
}

export function SessionCard({ info, onOpenTerminal, compact = false }: { info: SessionInfo; onOpenTerminal: () => void; compact?: boolean }) {
  const { components: C, hooks, utils } = runtime();
  const kill = hooks.useKillSession();
  const send = hooks.useSendInput();
  const { toast } = hooks.useToast();
  const { t } = hooks.useTranslation();
  const tasks = hooks.useTasks();
  const agentsExecs = useAgentsExecs();
  const name = info.name;
  const signal = hooks.useSessionSignal(name);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);

  // Map session → its task (prefer the in_progress one; agent names are reused across tasks).
  const task = utils.taskForSession(tasks.data ?? [], name);
  const exec = utils.taskExec(task?.labels);
  // The model running in this session: the task's exec for a worker, else the configured
  // pilot/overseer backend for the autopilot's own reasoning agents.
  const roleExec = info.role === 'overseer' ? agentsExecs.overseerExec
    : info.role === 'pilot' ? agentsExecs.pilotExec : undefined;
  // `taskExec` returns '' (not undefined) when a session has no task — pilot/overseer agents. Use
  // `||` so that empty worker exec falls through to the configured pilot/overseer backend, otherwise
  // `?? ` keeps the '' and the model pill never renders for the autopilot's own reasoning agents.
  const modelExec = exec || roleExec || undefined;
  // The epic an overseer governs — its title is the human name of the mission.
  const epic = info.role === 'overseer' && info.missionId
    ? (tasks.data ?? []).find((x) => x.id === utils.missionEpicId(info.missionId!))
    : undefined;
  const TypeIcon = task ? utils.taskTypeMeta(task.type).icon : SquareTerminal;
  const needsInput = signal?.type === 'needs_input';
  const dot = needsInput ? 'var(--color-warning)' : 'var(--color-approve)';
  const finished = !!task && (task.status === 'closed' || task.status === 'cancelled');

  // Action handlers defined once, shared between visible triggers and context menu.
  const handleTerminal = onOpenTerminal;
  const handleInterrupt = () => send.mutate({ name, keys: ['C-c'] }, { onSuccess: () => toast(t.sessions.interrupted.replace('{name}', utils.agentDisplayName(name))) });
  const handleKill = () => kill.mutate(name, { onSuccess: () => { setConfirmKill(false); toast(t.sessions.killed.replace('{name}', utils.agentDisplayName(name))); }, onError: (e) => toast(String(e), 'error') });

  const ctxItems: ContextMenuState['items'] = [
    { label: t.sessions.ctxTerminal, icon: TerminalSquare, onClick: handleTerminal },
    { label: t.sessions.ctxInterrupt, icon: SquareSlash, onClick: handleInterrupt },
    utils.contextMenuDivider,
    { label: t.sessions.ctxKill, icon: Power, onClick: () => setConfirmKill(true), danger: true },
  ];

  return (
    <C.EntityRow
      role="presentation"
      className={`group flex flex-col gap-3 ${needsInput ? 'border-l-2 border-warning/60 pl-3' : ''}`}
      onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, items: ctxItems }); }}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-elevated/70">
          {info.role === 'overseer' ? <Eye size={18} className="text-text-muted" aria-hidden />
            : info.role === 'pilot' ? <Bot size={18} className="text-text-muted" aria-hidden />
            : exec ? <C.ModelIcon name={exec} size={20} /> : <TypeIcon size={18} className="text-text-muted" aria-hidden />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          {info.role === 'overseer' ? (
            <>
              <span className="truncate text-xs font-semibold text-text" title={epic?.title}>{t.sessions.roleOverseer}{epic ? ` · ${epic.title}` : ''}</span>
              <span className="truncate font-mono text-[11px] text-text-muted">{info.missionId}</span>
            </>
          ) : info.role === 'pilot' ? (
            <>
              <span className="truncate text-xs font-semibold text-text">{t.sessions.rolePilot}</span>
              <span className="truncate text-[11px] text-text-muted">{info.agent}</span>
            </>
          ) : (
            <>
              <span className="truncate text-xs font-semibold text-text" title={task?.title}>{info.agent}</span>
              {/* The task pages live in the plugin that owns the task domain. No gate is needed here:
                  there is a task to link to only because the task READ was answered, which that same
                  plugin is what answers. */}
              {task ? <Link href={`/p/work/tasks?select=${encodeURIComponent(task.id)}`} className="truncate text-[11px] text-text-muted transition-colors hover:text-accent" title={task.title}>{task.title}</Link> : null}
            </>
          )}
        </div>
        {needsInput ? <span className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-tiny font-medium text-warning" title={signal?.type === 'needs_input' ? signal.question : ''}>{t.sessions.needsInput}</span> : null}
        <span className="live-dot h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot, ['--live-ring' as string]: needsInput ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-approve) 50%, transparent)' }} aria-label={needsInput ? t.sessions.needsInput : t.sessions.online} title={needsInput ? t.sessions.needsInput : t.sessions.online} />
      </div>
      {/* token usage on its own row under the header (not crammed into the identity column) */}
      {task ? <C.TaskUsageBadge taskId={task.id} live={!finished} /> : null}
      {finished && task ? (
        <div className={`flex flex-col gap-1.5 rounded-md border border-border bg-bg p-2.5 ${compact ? '' : 'min-h-32'}`}>
          <C.OutcomeBadge outcome={task.outcome} />
          <p className="text-[11px] leading-snug text-text-muted">{task.result_summary?.trim() || t.tasks.noSummary}</p>
        </div>
      ) : (
        <C.LiveTail name={name} lines={compact ? 14 : 22} heightClass={compact ? 'h-32' : 'h-52'} onExpand={onOpenTerminal} />
      )}
      {!finished && <C.ChangeStrip />}
      {needsInput && signal?.type === 'needs_input' && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
          <p className="text-xs text-text">{signal.question}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {signal.options && signal.options.length > 0 ? (
              <>
                {/* The agent asked a multiple-choice question — let the human pick the actual option
                    (navigating the list), not just accept the focused default with a bare Enter. */}
                {signal.options.map((o) => (
                  <button key={o.id} type="button" title={o.label} onClick={() => send.mutate({ name, keys: utils.keysForOption(o.id) }, { onSuccess: () => toast(t.sessions.answered.replace('{name}', utils.agentDisplayName(name)).replace('{option}', o.label)), onError: (e) => toast(String(e), 'error') })} className="max-w-full truncate rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-bg active:scale-95"><span className="opacity-60">{o.id}.</span> {o.label}</button>
                ))}
                <button type="button" onClick={() => send.mutate({ name, keys: ['Escape'] }, { onSuccess: () => toast(t.sessions.rejected.replace('{name}', utils.agentDisplayName(name))), onError: (e) => toast(String(e), 'error') })} className="rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-bg active:scale-95">{t.sessions.reject}</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => send.mutate({ name, keys: ['Enter'] }, { onSuccess: () => toast(t.sessions.approved.replace('{name}', utils.agentDisplayName(name))), onError: (e) => toast(String(e), 'error') })} className="rounded-md border border-approve/50 bg-approve/10 px-2.5 py-1 text-xs font-medium text-approve transition-colors hover:bg-approve hover:text-bg active:scale-95">{t.sessions.allow}</button>
                <button type="button" onClick={() => send.mutate({ name, keys: ['Escape'] }, { onSuccess: () => toast(t.sessions.rejected.replace('{name}', utils.agentDisplayName(name))), onError: (e) => toast(String(e), 'error') })} className="rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-bg active:scale-95">{t.sessions.reject}</button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <div className="flex items-center gap-1.5">
          <C.ProjectPill projectId={info.projectId ?? task?.project_id} always />
          {modelExec ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-2 py-0.5 text-[11px] text-text-muted" title={modelExec}>
              <C.ModelIcon name={modelExec} size={13} /><span className="max-w-28 truncate">{utils.execModel(modelExec)}</span>
            </span>
          ) : null}
          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <C.IconButton icon={TerminalSquare} label={t.sessions.terminal} onClick={handleTerminal} />
            <C.IconButton icon={SquareSlash} label={t.sessions.interrupt} onClick={handleInterrupt} />
            <C.ActionMenu
              label={t.sessions.kill}
              trigger={<MoreHorizontal size={15} aria-hidden />}
              triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              items={[{ label: t.sessions.kill, icon: Power, tone: 'danger', onSelect: () => setConfirmKill(true) }]}
            />
          </span>
        </div>
      </div>
      {/* Portal to <body>: the card lifts on hover (`transform: translateY`), which makes it the
          containing block for this `fixed` menu — so it would anchor to the card, not the viewport,
          and fly off to the clamp edge. Rendering outside the card restores viewport positioning. */}
      {ctxMenu && createPortal(<C.ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />, document.body)}
      <C.ConfirmDialog
        open={confirmKill}
        title={t.sessions.confirmKillTitle.replace('{name}', utils.agentDisplayName(name))}
        description={t.sessions.confirmKillDescription}
        confirmLabel={t.sessions.kill}
        onClose={() => setConfirmKill(false)}
        onConfirm={handleKill}
      />
    </C.EntityRow>
  );
}
