'use client';
import { useState } from 'react';
import { FolderGit2, GitBranch, GitCommitHorizontal, Plus } from 'lucide-react';
import { useProjects, useProjectGit } from '../../lib/queries';
import { useCreateProject } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { Section } from '../../components/ui/Section';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';

export function ProjectsView() {
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const git = useProjectGit(selectedId);

  const { toast } = useToast();
  const { t } = useTranslation();
  const createProject = useCreateProject();

  const [slug, setSlug] = useState('');
  const [path, setPath] = useState('');
  const [notes, setNotes] = useState('');

  function handleCreate() {
    createProject.mutate(
      { slug, path, notes },
      {
        onSuccess: () => {
          setCreating(false);
          setSlug('');
          setPath('');
          setNotes('');
          toast(t.projects.created);
        },
        onError: (e) => toast(String(e), 'error'),
      }
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <Section
        title={t.page.projects}
        icon={FolderGit2}
        actions={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>}
      >
        {projects.isLoading && <LoadingState />}
        {projects.isError && <ErrorState message={t.projects.loadError} onRetry={() => projects.refetch()} />}
        {projects.data && projects.data.length === 0 && <EmptyState title={t.projects.empty} />}
        {projects.data && projects.data.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.data.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`flex flex-col items-start gap-1 rounded-md border bg-bg p-4 text-left transition-colors ${selectedId === p.id ? 'border-accent' : 'border-border hover:border-border-strong'}`}
              >
                <span className="text-sm font-medium text-text">{p.slug}</span>
                <span className="truncate font-mono text-xs text-text-muted">{p.path}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {creating && (
        <Modal title={t.projects.newProject} onClose={() => setCreating(false)} size="md">
          <div className="flex flex-col gap-4 p-5">
            <Field label={t.projects.fieldSlug} hint={t.projects.slugHint}>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t.projects.slugPlaceholder} autoFocus />
            </Field>
            <Field label={t.projects.fieldPath} hint={t.projects.pathHint}>
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t.projects.pathPlaceholder} className="font-mono text-xs" />
            </Field>
            <Field label={t.projects.fieldNotes} hint={t.projects.notesHint}>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none" />
            </Field>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setCreating(false)}>{t.common.cancel}</Button>
              <Button variant="accent" onClick={handleCreate} disabled={createProject.isPending || !slug.trim() || !path.trim()}>{t.projects.create}</Button>
            </div>
          </div>
        </Modal>
      )}

      {selectedId && (
        <Section title={t.projects.git} icon={GitBranch}>
          {git.isLoading && <LoadingState />}
          {git.isError && <ErrorState message={t.projects.gitError} onRetry={() => git.refetch()} />}
          {git.data && !git.data.isRepo && <EmptyState title={t.projects.notGit} />}
          {git.data && git.data.isRepo && git.data.status && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-text">{git.data.status.branch}</span>
                <Badge tone={git.data.status.dirty > 0 ? 'danger' : 'muted'}>{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge>
                <Badge tone="accent">↑{git.data.status.ahead}</Badge>
                <Badge tone="accent">↓{git.data.status.behind}</Badge>
              </div>

              {git.data.branches.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-text">
                    <GitBranch size={14} className="text-text-muted" aria-hidden />
                    {t.projects.branches}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {git.data.branches.map((b) => (
                      <Badge key={b.name} tone={b.current ? 'accent' : 'muted'}>{b.name}{b.current ? ' *' : ''}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {git.data.commits.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-text">
                    <GitCommitHorizontal size={14} className="text-text-muted" aria-hidden />
                    {t.projects.commits}
                  </div>
                  <ul className="flex flex-col gap-2">
                    {git.data.commits.map((c) => (
                      <li key={c.hash} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg px-3 py-2 text-sm">
                        <span className="font-mono text-xs text-text-muted">{c.hash}</span>
                        <span className="text-text">{c.subject}</span>
                        <span className="text-xs text-text-muted">{c.author} · {c.relative}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
