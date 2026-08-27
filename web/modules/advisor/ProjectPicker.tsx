'use client';
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useDismiss } from '../../lib/useDismiss';
import { useTranslation } from '../../lib/i18n';
import { useProjects } from '../../lib/queries';
import { elowenClient } from '../../lib/elowenClient';
import { useToast } from '../../components/ui/Toast';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
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
  const rootRef = useRef<HTMLDivElement>(null);

  useDismiss(rootRef, open, () => setOpen(false));

  const items = projects.data ?? [];
  const cwd = telemetry.project?.cwd ?? null;
  const current = projectForPath(items, cwd);

  // Nothing to switch between is not a control. A single project is already where every turn runs, and an
  // instance with none has no directory to offer — in both cases the button would only take space and
  // suggest a choice that does not exist.
  if (items.length < 2) return null;

  const move = async (project: ProjectLike): Promise<void> => {
    setOpen(false);
    if (project.id === current?.id) return;
    setMoving(true);
    try {
      await elowenClient.brainSetCwd(project.path, activeSessionId ?? undefined);
    } catch (e) {
      // The daemon refuses a directory the caller cannot reach, and refuses entirely when no conversation
      // is live. Surfacing its own words beats a generic failure: those two cases need different fixes.
      toast((e as Error).message || t.brainChat.projectPickerFailed, 'error');
    } finally {
      setMoving(false);
    }
  };

  const label = current?.slug ?? t.brainChat.projectPickerNone;

  return (
    <div ref={rootRef} data-testid="chat-project-picker" className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={moving}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={cwd ? `${t.brainChat.projectPicker}: ${cwd}` : t.brainChat.projectPicker}
        className={`flex items-center gap-1.5 rounded-md border border-border text-text-muted transition-colors hover:bg-elevated hover:text-text disabled:opacity-50 ${
          variant === 'compact' ? 'h-7 max-w-[130px] px-2 text-tiny' : 'h-8 max-w-[200px] px-2.5 text-xs'
        }`}
      >
        {current ? <ProjectIcon project={current} size={variant === 'compact' ? 12 : 14} /> : null}
        <span className="truncate">{label}</span>
        <ChevronDown size={variant === 'compact' ? 12 : 14} className="shrink-0" aria-hidden />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label={t.brainChat.projectPicker}
          className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-border bg-elevated py-1 shadow-lg"
        >
          {items.map((project) => (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected={project.id === current?.id}
              onClick={() => void move(project)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-bg ${
                project.id === current?.id ? 'text-accent' : 'text-text'
              }`}
            >
              <ProjectIcon project={project} size={14} />
              <span className="min-w-0 flex-1 truncate">{project.slug}</span>
              <span className="shrink-0 truncate font-mono text-tiny text-text-muted" title={project.path}>{project.path}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
