'use client';
import { useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import { useProjects } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { ProjectIcon } from './ProjectIcon';
import { MorePill } from './MorePill';

/** How many project pills show before the tail folds behind "+N more" — a long workspace list would
 *  otherwise flood the page's single header filter row (and push its other controls out of a narrow
 *  window entirely). */
const PROJECT_PREVIEW = 5;

/** Shared project filter pills — "All projects" + one pill per accessible project. Hidden when the
 *  workspace has fewer than two projects (no choice to make). Purely presentational: the host owns
 *  the selected value (and persists it) and feeds it back via `onChange`. Set `includeAll={false}`
 *  for surfaces that need exactly one project (e.g. the editor), which drops the "All" pill.
 *  Past {@link PROJECT_PREVIEW} projects the tail folds behind the shared MorePill toggle; expanding
 *  wraps the rest onto the following line(s). A selected project inside the folded tail is shown as
 *  one extra pill (stable order — picking a project never reshuffles the row). */
export function ProjectFilterPills({ value, onChange, includeAll = true }: { value: number | 'all'; onChange: (v: number | 'all') => void; includeAll?: boolean }) {
  const { data: projects } = useProjects();
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  if (!projects || projects.length < 2) return null;
  const folded = !showAll && projects.length > PROJECT_PREVIEW;
  const head = folded ? projects.slice(0, PROJECT_PREVIEW) : projects;
  const selected = folded ? projects.find((p) => p.id === value) : undefined;
  const visible = selected && !head.some((p) => p.id === selected.id) ? [...head, selected] : head;
  const pillClass = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`;
  return (
    <div role="group" aria-label={t.tasks.filterProjectsAria} className="flex flex-wrap items-center gap-1.5">
      {includeAll ? (
        <button type="button" aria-pressed={value === 'all'} onClick={() => onChange('all')} className={pillClass(value === 'all')} style={{ transitionDuration: 'var(--motion-fast)' }}>
          <FolderGit2 size={13} className="shrink-0" aria-hidden />{t.tasks.filterAllProjects}
        </button>
      ) : null}
      {visible.map((p) => (
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
      {projects.length > PROJECT_PREVIEW ? (
        <MorePill expanded={showAll} hidden={projects.length - visible.length} onToggle={() => setShowAll((v) => !v)} />
      ) : null}
    </div>
  );
}
