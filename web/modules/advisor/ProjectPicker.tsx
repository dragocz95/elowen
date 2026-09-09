'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useMe, useProjects } from '../../lib/queries';
import { apiErrorMessage, elowenClient } from '../../lib/elowenClient';
import type { ProjectExecutionRef } from '../../lib/types';
import { useToast } from '../../components/ui/Toast';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { managedProjectStrings } from '../projects/managedProjectStrings';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../../components/ui/shadcn/dropdown-menu';
import { useBrainChat } from './BrainChatProvider';

/** Selection comes from durable execution identity, never from cwd or conversation filing. */
export function ProjectPicker({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { t, locale } = useTranslation();
  const s = managedProjectStrings[locale];
  const { toast } = useToast();
  const { telemetry, activeSessionId } = useBrainChat();
  const projects = useProjects();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin === true;
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveStatus, setMoveStatus] = useState<SaveStatus>('idle');
  const [retryTarget, setRetryTarget] = useState<ProjectExecutionRef | null>(null);
  const [hostTarget, setHostTarget] = useState<ProjectExecutionRef | null>(null);
  const [confirmed, setConfirmed] = useState<{ session: string; target: ProjectExecutionRef } | null>(null);
  const sessionRef = useRef(activeSessionId);
  sessionRef.current = activeSessionId;
  const reported = telemetry.projectRef;
  useEffect(() => { setConfirmed(null); setMoveStatus('idle'); setRetryTarget(null); setHostTarget(null); }, [activeSessionId, reported?.kind, reported?.projectId]);
  const target = confirmed?.session === activeSessionId ? confirmed.target : reported;
  const items = (projects.data ?? []).filter((p) => p.lifecycle !== 'deleting' && (p.executionKind === 'managed' || isAdmin));
  const current = target?.projectId ? projects.data?.find((p) => p.id === target.projectId) : undefined;
  // The picker names the project a conversation runs in, and nothing else. A host target with no project
  // behind it has no name to show, so it reads as an unselected target — the same neutral wording any
  // other nameless target gets. This is presentation: the conversation's execution state is untouched,
  // and host authority still lives in the confirmation below and in the daemon.
  const label = current?.slug ?? s.unknownTarget;
  const ready = Boolean(activeSessionId) && !projects.isLoading && !projects.isError && !me.isLoading && !me.isError;

  const move = async (next: ProjectExecutionRef) => {
    const session = activeSessionId;
    if (!session || moving || (next.kind === 'host' && !isAdmin)) return;
    setOpen(false); setRetryTarget(next); setMoveStatus('saving'); setMoving(true);
    try {
      const response = await elowenClient.brainSetExecution(next, session);
      if (sessionRef.current !== session) return;
      setConfirmed({ session, target: response.projectRef }); setMoveStatus('idle'); setHostTarget(null);
    } catch (error) {
      const message = apiErrorMessage(error) || t.brainChat.projectPickerFailed;
      if (sessionRef.current === session) { setMoveStatus('error'); toast(message, 'error'); }
      throw new Error(message);
    } finally { setMoving(false); }
  };
  const select = (next: ProjectExecutionRef) => {
    setOpen(false);
    if (next.kind === 'host') setHostTarget(next);
    else void move(next).catch(() => {}); // The failed mutation remains visible with a retry action.
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
        {/* Every entry is a registered project, named the way it is named everywhere else. Choosing a host
            project still produces a `host` target, still asks for confirmation and still travels the same
            authorized execution endpoint — the change here is presentation, not authority. Standalone
            host mode is not offered as a destination of its own; host administration keeps its home in
            Projects, the CLI and the API. */}
        <DropdownMenuRadioGroup value={target ? `${target.kind}:${target.projectId ?? ''}` : ''} onValueChange={(value) => {
          const project = items.find((p) => `${p.executionKind ?? 'host'}:${p.id}` === value);
          if (project) select({ kind: project.executionKind === 'managed' ? 'managed' : 'host', projectId: project.id });
        }}>
          {items.map((p) => <DropdownMenuRadioItem key={p.id} value={`${p.executionKind ?? 'host'}:${p.id}`} className="gap-2 text-xs">
            <ProjectIcon project={p} size={14} /><span className="min-w-0 flex-1 truncate">{p.slug}</span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <AutoSaveStatus status={moveStatus} onRetry={() => { if (retryTarget && !moving) select(retryTarget); }} />
    <ConfirmDialog open={hostTarget !== null} title={s.hostConfirm} description={s.hostWarning} confirmLabel={s.hostConfirm} pending={moving}
      onClose={() => setHostTarget(null)} onConfirm={async () => { if (hostTarget) await move(hostTarget); }} />
  </div>;
}
