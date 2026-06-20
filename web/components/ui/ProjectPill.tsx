'use client';
import { FolderGit2 } from 'lucide-react';
import { useProjects } from '../../lib/queries';

/** Small muted pill showing which project/repo a card belongs to. Hidden when the workspace has
 *  only one project (it's noise then) or when the id can't be resolved to a slug. */
export function ProjectPill({ projectId }: { projectId?: number }) {
  const { data: projects } = useProjects();
  if (projectId == null || !projects || projects.length < 2) return null;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
      title={project.path}
    >
      <FolderGit2 size={11} className="shrink-0" aria-hidden />
      <span className="max-w-32 truncate">{project.slug}</span>
    </span>
  );
}
