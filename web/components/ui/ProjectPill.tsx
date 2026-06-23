'use client';
import { useProjects } from '../../lib/queries';
import { ProjectIcon } from './ProjectIcon';

/** Small muted pill showing which project/repo a card belongs to. Hidden when the workspace has
 *  only one project (it's noise then) or when the id can't be resolved to a slug. Pass `always` to
 *  show it even in a single-project workspace — on session cards "where is this agent working" is
 *  meaningful confirmation, not noise. */
export function ProjectPill({ projectId, always = false }: { projectId?: number; always?: boolean }) {
  const { data: projects } = useProjects();
  if (projectId == null || !projects || (!always && projects.length < 2)) return null;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
      title={project.path}
    >
      <ProjectIcon project={project} size={11} />
      <span className="max-w-32 truncate">{project.slug}</span>
    </span>
  );
}
