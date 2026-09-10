'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useProjects } from '../../lib/queries';
import { apiErrorMessage, elowenClient } from '../../lib/elowenClient';
import { executionRefKey, executionRefOf, type ProjectExecutionRef } from '../../lib/types';
import { useToast } from '../../components/ui/Toast';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../../components/ui/shadcn/dropdown-menu';
import { OperationProgressDialog } from '../../components/ui/OperationProgressDialog';
import { useEnvironmentOperationWindow } from '../../lib/useEnvironmentOperation';
import { recreatable, requestEnvironmentAction } from '../../lib/environmentActions';
import { useBrainChat } from './BrainChatProvider';

/** Selection comes from durable execution identity, never from cwd or conversation filing. */
export function ProjectPicker({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { t } = useTranslation();
  const s = t.projects;
  const { toast } = useToast();
  const { telemetry, activeSessionId } = useBrainChat();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveStatus, setMoveStatus] = useState<SaveStatus>('idle');
  const [retryTarget, setRetryTarget] = useState<ProjectExecutionRef | null>(null);
  const [confirmed, setConfirmed] = useState<{ session: string; target: ProjectExecutionRef } | null>(null);
  // The environment the switch asked for, followed until it settles.
  const environment = useEnvironmentOperationWindow();
  const { forget } = environment;
  const sessionRef = useRef(activeSessionId);
  sessionRef.current = activeSessionId;
  const reported = telemetry.projectRef;
  useEffect(() => { setConfirmed(null); setMoveStatus('idle'); setRetryTarget(null); }, [activeSessionId, reported?.kind, reported?.projectId]);
  // Another conversation's environment is not this one's business: what the picker follows belongs to the
  // switch that started it, and only the reported target moves while that switch is still coming up.
  useEffect(() => { forget(); }, [activeSessionId, forget]);
  const target = confirmed?.session === activeSessionId ? confirmed.target : reported;
  // A host project is a project: whoever the API offers it to may work in it, and the daemon confines
  // the turn to that project's root exactly as it confines a managed one to its environment.
  const items = (projects.data ?? []).filter((p) => p.lifecycle !== 'deleting');
  const current = target?.projectId ? projects.data?.find((p) => p.id === target.projectId) : undefined;
  // The picker names the project a conversation runs in, and nothing else. A host target with no project
  // behind it has no name to show, and it is a target that WAS chosen: the label says there is no
  // project, the same thing the new-conversation modal offers, rather than claiming nothing is selected.
  const label = current?.slug ?? t.brainChat.projectPickerHost;
  const ready = Boolean(activeSessionId) && !projects.isLoading && !projects.isError;
  const dispatch = (action: 'start' | 'recreate') => {
    const projectId = environment.pending?.projectId;
    if (projectId === undefined) return;
    void requestEnvironmentAction(projectId, { kind: action }, environment.operation?.generation)
      .then((operation) => environment.follow(operation.id, projectId))
      .catch((error) => toast(apiErrorMessage(error) || t.brainChat.projectPickerFailed, 'error'));
  };

  const move = async (next: ProjectExecutionRef) => {
    const session = activeSessionId;
    if (!session || moving) return;
    setOpen(false); setRetryTarget(next); setMoveStatus('saving'); setMoving(true);
    try {
      const response = await elowenClient.brainSetExecution(next, session);
      if (sessionRef.current !== session) return;
      setConfirmed({ session, target: response.projectRef }); setMoveStatus('idle');
      // The switch itself is already done — the daemon answered before the container work started. What
      // comes back is the operation that brings the environment up, and following it is what replaces
      // the spinner that used to sit on the save indicator until the container happened to appear.
      if (response.operationId && next.projectId !== undefined) environment.follow(response.operationId, next.projectId);
    } catch (error) {
      const message = apiErrorMessage(error) || t.brainChat.projectPickerFailed;
      if (sessionRef.current === session) { setMoveStatus('error'); toast(message, 'error'); }
      throw new Error(message);
    } finally { setMoving(false); }
  };
  // Host mode asks nothing. An execution target is a working decision, and the daemon is the authority
  // on whether this account may enter the project — a dialog in front of it only stood between people
  // and the projects they already work in.
  const select = (next: ProjectExecutionRef) => {
    setOpen(false);
    void move(next).catch(() => {}); // The failed mutation remains visible with a retry action.
  };
  return <div data-testid="chat-project-picker" className="relative shrink-0">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={moving || !ready} title={s.executionKind}
          className={`flex items-center gap-1.5 rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40 ${variant === 'compact' ? 'h-7 max-w-[180px] px-2 text-tiny' : 'h-8 max-w-[240px] px-2.5 text-xs'}`}>
          {current ? <ProjectIcon project={current} size={14} /> : null}
          <span className="truncate">{label}</span><ChevronDown size={12} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={s.executionKind} align="end" className="max-h-80 w-64">
        {/* Every entry is a registered project, named the way it is named everywhere else, and the list is
            already the set this account may reach (GET /projects filters it). Choosing a host project
            produces a `host` target and travels the same authorized execution endpoint a managed one does.
            Standalone host mode is not offered as a destination of its own; host administration keeps its
            home in Projects, the CLI and the API. */}
        <DropdownMenuRadioGroup value={target ? executionRefKey(target) : ''} onValueChange={(value) => {
          const project = items.find((p) => executionRefKey(executionRefOf(p)) === value);
          if (project) select(executionRefOf(project));
        }}>
          {items.map((p) => <DropdownMenuRadioItem key={p.id} value={executionRefKey(executionRefOf(p))} className="gap-2 text-xs">
            <ProjectIcon project={p} size={14} /><span className="min-w-0 flex-1 truncate">{p.slug}</span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <AutoSaveStatus status={moveStatus} onRetry={() => { if (retryTarget && !moving) select(retryTarget); }} />
    {/* Hiding the window does not stop the environment coming up, so the chip is the way back into it. */}
    {environment.pending && !environment.open ? (
      <button type="button" data-testid="chat-environment-chip" onClick={environment.show}
        className="ml-1 rounded-md border border-border px-1.5 py-0.5 text-tiny text-muted-foreground hover:bg-accent">
        {t.operationProgress.reopen}
      </button>
    ) : null}
    <OperationProgressDialog
      open={environment.open && environment.pending !== null}
      title={t.operationProgress.actions[(environment.operation?.action.kind ?? 'start') as keyof typeof t.operationProgress.actions] ?? t.operationProgress.actions.start}
      operation={environment.operation}
      logTail={environment.logTail}
      loadError={environment.loadError}
      onRetry={() => dispatch('start')}
      onRecreate={() => dispatch('recreate')}
      recreatable={recreatable(environment.operation?.error)}
      onSettled={environment.forget}
      onClose={({ running }) => { if (running || environment.running) environment.hide(); else environment.forget(); }}
    />
  </div>;
}
