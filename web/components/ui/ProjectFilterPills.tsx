'use client';
import { useState } from 'react';
import { ChevronDown, FolderGit2 } from 'lucide-react';
import { useProjects } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { ProjectIcon } from './ProjectIcon';
import { MorePill } from './MorePill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu';
import { RadioGroup, RadioGroupItem } from './shadcn/radio-group';

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
  const choose = (next: string) => onChange(next === 'all' ? 'all' : Number(next));

  if (!projects || projects.length < 2) return null;
  if (variant === 'dropdown') {
    const selected = value === 'all' ? null : projects.find((project) => project.id === value);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t.common.filterProjectsAria}
            className="group inline-flex h-9 max-w-full items-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground transition-[border-color,background-color,box-shadow] hover:border-border-strong hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-primary/60 data-[state=open]:bg-primary/10 data-[state=open]:text-primary data-[state=open]:shadow-[0_0_0_3px_rgb(var(--primary-rgb)/0.08)]"
          >
            <FolderGit2 size={13} className="shrink-0 text-primary" aria-hidden />
            <span className="max-w-32 truncate">{selected?.slug ?? t.common.filterAllProjects}</span>
            <ChevronDown size={13} className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={t.common.filterProjectsAria} align="start" sideOffset={8} className="w-64 origin-top-left">
          <DropdownMenuRadioGroup value={String(value)} onValueChange={choose}>
            {includeAll ? (
              <DropdownMenuRadioItem value="all">
                <FolderGit2 size={14} className="shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.common.filterAllProjects}</span>
              </DropdownMenuRadioItem>
            ) : null}
            <DropdownMenuSeparator />
            {projects.map((project) => (
              <DropdownMenuRadioItem key={project.id} value={String(project.id)} title={project.path}>
                <ProjectIcon project={project} size={14} />
                <span className="min-w-0 flex-1 truncate">{project.slug}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const folded = !showAll && projects.length > PROJECT_PREVIEW;
  const head = folded ? projects.slice(0, PROJECT_PREVIEW) : projects;
  const selected = folded ? projects.find((project) => project.id === value) : undefined;
  const visible = selected && !head.some((project) => project.id === selected.id) ? [...head, selected] : head;
  const pillClass = 'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-accent-foreground data-[state=checked]:border-primary/50 data-[state=checked]:bg-primary/15 data-[state=checked]:text-primary';

  return (
    <RadioGroup
      value={String(value)}
      onValueChange={choose}
      aria-label={t.common.filterProjectsAria}
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
    >
      {includeAll ? (
        <RadioGroupItem value="all" appearance="segmented" className={pillClass} style={{ transitionDuration: 'var(--motion-fast)' }}>
          <FolderGit2 size={13} className="shrink-0" aria-hidden />{t.common.filterAllProjects}
        </RadioGroupItem>
      ) : null}
      {visible.map((project) => (
        <RadioGroupItem
          key={project.id}
          value={String(project.id)}
          appearance="segmented"
          title={project.path}
          className={pillClass}
          style={{ transitionDuration: 'var(--motion-fast)' }}
        >
          <ProjectIcon project={project} size={13} /><span className="min-w-0 max-w-48 truncate">{project.slug}</span>
        </RadioGroupItem>
      ))}
      {projects.length > PROJECT_PREVIEW ? (
        <MorePill expanded={showAll} hidden={projects.length - visible.length} onToggle={() => setShowAll((current) => !current)} />
      ) : null}
    </RadioGroup>
  );
}
