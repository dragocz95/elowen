'use client';
import { GitCommitHorizontal } from 'lucide-react';
import { useProjectGit, useProjects } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

/** Compact one-line "what changed" strip: dirty count + last commit subject.
 *  Resolves the project via useProjects (first project's id) and renders nothing
 *  while the git info is loading or unavailable. Attribution is heuristic — just
 *  dirty count and the most recent commit subject, no false precision. */
export function ChangeStrip() {
  const { t } = useTranslation();
  const projects = useProjects();
  const projectId = projects.data?.[0]?.id ?? null;
  const git = useProjectGit(projectId);

  if (!git.data) return null;
  const { status, commits } = git.data;
  if (!status) return null;
  const dirty = status.dirty;
  const last = commits[0];

  // Nothing to show: clean tree and no commits — keep the strip quiet.
  if (dirty === 0 && !last) return null;

  const dirtyLabel = dirty === 0 ? null : dirty === 1 ? t.changes.dirtyOne : t.changes.dirtyN.replace('{count}', String(dirty));

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground" title={last ? t.changes.lastCommit.replace('{relative}', last.relative).replace('{subject}', last.subject) : (dirtyLabel ?? '')}>
      <GitCommitHorizontal size={12} className="shrink-0 text-muted-foreground" aria-hidden />
      {dirtyLabel ? <span className="shrink-0 text-warning">{dirtyLabel}</span> : null}
      {last ? <span className="min-w-0 flex-1 truncate">{t.changes.lastCommit.replace('{relative}', last.relative).replace('{subject}', last.subject)}</span> : null}
    </span>
  );
}