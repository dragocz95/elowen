'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderGit2 } from 'lucide-react';
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
 *  reveals the rest in a wrapping group. A selected project inside the folded tail is shown as one
 *  extra pill (stable order — picking a project never reshuffles the row). */
export function ProjectFilterPills({ value, onChange, includeAll = true, variant = 'pills' }: { value: number | 'all'; onChange: (v: number | 'all') => void; includeAll?: boolean; variant?: 'pills' | 'dropdown' }) {
  const { data: projects } = useProjects();
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || variant !== 'dropdown') return;
    const onPointerDown = (event: PointerEvent) => { if (!dropdownRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open, variant]);
  if (!projects || projects.length < 2) return null;
  if (variant === 'dropdown') {
    const selected = value === 'all' ? null : projects.find((project) => project.id === value);
    const choose = (next: number | 'all') => { onChange(next); setOpen(false); };
    return (
      <div ref={dropdownRef} className="relative min-w-0 max-w-full shrink-0">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t.tasks.filterProjectsAria}
          onClick={() => setOpen((current) => !current)}
          className={`inline-flex h-9 max-w-full items-center gap-2 rounded-md border px-3 text-sm font-medium transition-[border-color,background-color,box-shadow] ${open ? 'border-accent/60 bg-accent/10 text-accent shadow-[0_0_0_3px_rgb(255_82_54_/_0.08)]' : 'border-border bg-surface text-text hover:border-border-strong hover:bg-elevated'}`}
        >
          <FolderGit2 size={14} className="shrink-0 text-accent" aria-hidden />
          <span className="max-w-40 truncate">{selected?.slug ?? t.tasks.filterAllProjects}</span>
          <ChevronDown size={14} className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {open ? (
          <div role="menu" aria-label={t.tasks.filterProjectsAria} className="absolute left-0 top-full z-40 mt-2 w-64 origin-top-left animate-fade-up rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-raised)]">
            {includeAll ? (
              <button type="button" role="menuitemradio" aria-checked={value === 'all'} onClick={() => choose('all')} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-text transition-colors hover:bg-elevated">
                <FolderGit2 size={14} className="shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.tasks.filterAllProjects}</span>
                {value === 'all' ? <Check size={15} className="shrink-0 text-accent" aria-hidden /> : null}
              </button>
            ) : null}
            <div className="my-1 border-t border-border" role="separator" />
            {projects.map((project) => (
              <button key={project.id} type="button" role="menuitemradio" aria-checked={value === project.id} onClick={() => choose(project.id)} title={project.path} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-text transition-colors hover:bg-elevated">
                <ProjectIcon project={project} size={14} />
                <span className="min-w-0 flex-1 truncate">{project.slug}</span>
                {value === project.id ? <Check size={15} className="shrink-0 text-accent" aria-hidden /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const folded = !showAll && projects.length > PROJECT_PREVIEW;
  const head = folded ? projects.slice(0, PROJECT_PREVIEW) : projects;
  const selected = folded ? projects.find((p) => p.id === value) : undefined;
  const visible = selected && !head.some((p) => p.id === selected.id) ? [...head, selected] : head;
  const pillClass = (on: boolean) =>
    `inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`;
  return (
    <div role="group" aria-label={t.tasks.filterProjectsAria} className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
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
          <ProjectIcon project={p} size={13} /><span className="min-w-0 max-w-48 truncate">{p.slug}</span>
        </button>
      ))}
      {projects.length > PROJECT_PREVIEW ? (
        <MorePill expanded={showAll} hidden={projects.length - visible.length} onToggle={() => setShowAll((v) => !v)} />
      ) : null}
    </div>
  );
}
