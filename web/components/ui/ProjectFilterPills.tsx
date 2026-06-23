'use client';
import { FolderGit2 } from 'lucide-react';
import { useProjects } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { ProjectIcon } from './ProjectIcon';

/** Shared project filter pills — "All projects" + one pill per accessible project. Hidden when the
 *  workspace has fewer than two projects (no choice to make). Purely presentational: the host owns
 *  the selected value (and persists it) and feeds it back via `onChange`. */
export function ProjectFilterPills({ value, onChange }: { value: number | 'all'; onChange: (v: number | 'all') => void }) {
  const { data: projects } = useProjects();
  const { t } = useTranslation();
  if (!projects || projects.length < 2) return null;
  const pillClass = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`;
  return (
    <div role="group" aria-label={t.tasks.filterProjectsAria} className="flex flex-wrap items-center gap-1.5">
      <button type="button" aria-pressed={value === 'all'} onClick={() => onChange('all')} className={pillClass(value === 'all')} style={{ transitionDuration: 'var(--motion-fast)' }}>
        <FolderGit2 size={13} className="shrink-0" aria-hidden />{t.tasks.filterAllProjects}
      </button>
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={value === p.id}
          onClick={() => onChange(p.id)}
          title={p.path}
          className={pillClass(value === p.id)}
          style={{ transitionDuration: 'var(--motion-fast)' }}
        >
          <ProjectIcon project={p} size={13} />{p.slug}
        </button>
      ))}
    </div>
  );
}