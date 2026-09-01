'use client';
import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useProjects } from '../../lib/queries';
import { elowenClient } from '../../lib/elowenClient';
import { useToast } from '../../components/ui/Toast';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../components/ui/shadcn/dropdown-menu';
import { useBrainChat } from './BrainChatProvider';

interface ProjectLike { id: number; slug: string; path: string; icon?: string }

/** Which registered project a working directory belongs to. Containment, not equality: the agent may sit
 *  in a subdirectory and still be working in that project. Nested registrations are real (a monorepo
 *  registered alongside one of its packages), so the LONGEST matching path wins — the innermost project is
 *  the one the directory is actually in.
 *
 *  The boundary check is deliberately `path + '/'` rather than a bare prefix: `/var/www/kolin-worktrees`
 *  starts with `/var/www/kolin` as a string while being an entirely different directory, and reporting the
 *  wrong project would be worse than reporting none. */
export function projectForPath(projects: ProjectLike[], cwd: string | null | undefined): ProjectLike | null {
  if (!cwd) return null;
  let best: ProjectLike | null = null;
  for (const project of projects) {
    const root = project.path.replace(/\/+$/, '');
    if (!root) continue;
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.path.replace(/\/+$/, '').length) best = project;
  }
  return best;
}

/** The chat's working-directory control: which registered project this conversation operates in. Sits
 *  beside the model picker because it answers the same kind of question — not what the agent is, but where
 *  it is.
 *
 *  It writes through `POST /brain/cwd`, the same seam the CLI's `/cd` uses, so the daemon keeps the single
 *  policy check: a directory the caller may not reach is refused there rather than being filtered here,
 *  where a stale project list could let one through. The move also records a session event, which tells the
 *  running agent it has moved and makes the status poll refetch — so the label below is never local state
 *  that could drift from where the agent actually is, it is always the daemon's answer. */
export function ProjectPicker({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { telemetry, activeSessionId } = useBrainChat();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveStatus, setMoveStatus] = useState<SaveStatus>('idle');
  const [retryProject, setRetryProject] = useState<ProjectLike | null>(null);
  // The directory the daemon confirmed in its reply to our own move, held only until the status poll
  // catches up. It exists because that poll is driven by a session event, and a session event is
  // SUPPRESSED for a conversation with no messages yet (`sessionEvents.ts` returns early when
  // `lastMessageAt` is empty). Without this, picking a project in a brand-new chat would succeed while
  // the label kept reading "no project" — the move working but appearing not to. This is not optimism:
  // it is the value the daemon returned for the move it just performed.
  const [confirmed, setConfirmed] = useState<string | null>(null);

  const reported = telemetry.project?.cwd ?? null;
  // A different conversation, or a poll that has caught up, both retire the held value — after which the
  // label is the daemon's status again and cannot drift.
  useEffect(() => { setConfirmed(null); setMoveStatus('idle'); setRetryProject(null); }, [activeSessionId, reported]);

  const items = projects.data ?? [];
  const cwd = confirmed ?? reported;
  const current = projectForPath(items, cwd);

  // Nothing to switch between is not a control. A single project is already where every turn runs, and an
  // instance with none has no directory to offer — in both cases the button would only take space and
  // suggest a choice that does not exist.
  if (items.length < 2) return null;

  // No live conversation, no directory to move. `/brain/cwd` resolves the caller's ACTIVE session and
  // answers 409 "brain not started" when there is none, which is exactly the state a freshly opened chat
  // is in before its first turn — so offering the control there would hand the user an error for doing
  // what the interface invited them to do.
  const ready = Boolean(activeSessionId);

  const move = async (project: ProjectLike): Promise<void> => {
    setOpen(false);
    if (project.id === current?.id) return;
    setRetryProject(project);
    setMoveStatus('saving');
    setMoving(true);
    try {
      const { workDir } = await elowenClient.brainSetCwd(project.path, activeSessionId ?? undefined);
      setConfirmed(workDir);
      setMoveStatus('saved');
    } catch (e) {
      // The daemon refuses a directory the caller cannot reach. Surfacing its own words beats a generic
      // failure, because that refusal names a cause the user can act on.
      setMoveStatus('error');
      toast((e as Error).message || t.brainChat.projectPickerFailed, 'error');
    } finally {
      setMoving(false);
    }
  };

  const label = current?.slug ?? t.brainChat.projectPickerNone;

  return (
    <div data-testid="chat-project-picker" className="relative shrink-0">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={moving || !ready}
            title={cwd ? `${t.brainChat.projectPicker}: ${cwd}` : t.brainChat.projectPicker}
            aria-disabled={!ready}
            // Named by its current project, for the same reason as ModelPicker's twin trigger next to it.
            className={`flex items-center gap-1.5 rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 ${
              variant === 'compact' ? 'h-7 max-w-[130px] px-2 text-tiny' : 'h-8 max-w-[200px] px-2.5 text-xs'
            }`}
          >
            {current ? <ProjectIcon project={current} size={variant === 'compact' ? 12 : 14} /> : null}
            <span className="truncate">{label}</span>
            <ChevronDown size={variant === 'compact' ? 12 : 14} className="shrink-0 opacity-60" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label={t.brainChat.projectPicker}
          align="end"
          sideOffset={4}
          className="max-h-80 w-64 p-0 py-1"
        >
          <DropdownMenuRadioGroup
            value={current ? String(current.id) : ''}
            onValueChange={(value) => {
              const project = items.find((item) => String(item.id) === value);
              if (project) void move(project);
            }}
          >
            {items.map((project) => (
              <DropdownMenuRadioItem
                key={project.id}
                value={String(project.id)}
                className="gap-2 rounded-none px-2.5 py-1.5 text-xs text-foreground data-[state=checked]:text-primary [&>span:first-child]:hidden"
              >
                <ProjectIcon project={project} size={14} />
                <span className="min-w-0 flex-1 truncate">{project.slug}</span>
                <span className="shrink-0 truncate font-mono text-tiny text-muted-foreground" title={project.path}>{project.path}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AutoSaveStatus status={moveStatus} onRetry={() => { if (retryProject && !moving) void move(retryProject); }} />
    </div>
  );
}
