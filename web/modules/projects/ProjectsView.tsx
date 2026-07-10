'use client';
import { useState } from 'react';
import { FolderGit2, GitBranch, GitCommitHorizontal, Plus, CheckCircle2, AlertTriangle, ArrowUp, ArrowDown, Folder } from 'lucide-react';
import { useProjects, useProjectGit } from '../../lib/queries';
import { useCreateProject, useUpdateProject, useRemoveProject } from '../../lib/mutations';
import type { Project } from '../../lib/types';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { Code2, Copy, Pencil, Trash2, ImageIcon } from 'lucide-react';
import { ContextMenu, DIVIDER, type ContextMenuState } from '../../components/ui/ContextMenu';
import { ProjectEditor } from './editor/ProjectEditor';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { ProjectIconPicker } from './ProjectIconPicker';
import { DirectoryPicker } from './DirectoryPicker';

export function ProjectsView() {
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingCommit, setEditingCommit] = useState<string | null>(null);
  const [editingWorking, setEditingWorking] = useState(false);
  const [creating, setCreating] = useState(false);

  const openEditor = (commit: string | null) => { setEditingId(selectedId); setEditingCommit(commit); setEditingWorking(false); };
  const openWorking = () => { setEditingId(selectedId); setEditingCommit(null); setEditingWorking(true); };
  const closeEditor = () => { setEditingId(null); setEditingCommit(null); setEditingWorking(false); };
  const git = useProjectGit(selectedId);

  const { toast } = useToast();
  const { t } = useTranslation();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const removeProject = useRemoveProject();
  // Project pending removal — drives the confirm dialog. Removal detaches the project from elowen
  // (tasks/missions/access) but never touches files on disk; the backend rejects the home project.
  const [removing, setRemoving] = useState<Project | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  function openCtxMenu(e: React.MouseEvent, p: Project) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t.projects.ctxOpenEditor, icon: Code2, onClick: () => { setSelectedId(p.id); setEditingId(p.id); setEditingCommit(null); setEditingWorking(false); } },
        { label: t.projects.ctxEditProject, icon: Pencil, onClick: () => { setSelectedId(p.id); openEdit(p); } },
        DIVIDER,
        { label: t.projects.ctxCopyPath, icon: Copy, onClick: () => { navigator.clipboard.writeText(p.path); toast(t.projects.ctxPathCopied); } },
        DIVIDER,
        { label: t.projects.ctxRemove, icon: Trash2, danger: true, onClick: () => setRemoving(p) },
      ],
    });
  }

  const [slug, setSlug] = useState('');
  const [path, setPath] = useState('');
  const [notes, setNotes] = useState('');
  // Server-side folder picker for the new-project path (opens over the create modal).
  const [browsing, setBrowsing] = useState(false);

  // Edit-project modal: pre-filled from the chosen project; slug stays read-only.
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editPath, setEditPath] = useState('');
  const [editNotes, setEditNotes] = useState('');
  // Per-project GitHub PR-flow override: null = inherit the global default, true/false = force on/off.
  const [editPrEnabled, setEditPrEnabled] = useState<boolean | null>(null);
  const openEdit = (p: Project) => { setEditProject(p); setEditPath(p.path); setEditNotes(p.notes); setEditPrEnabled(p.pr_enabled); };
  // Project whose icon is being chosen (drives the icon-picker modal, stacked over the edit modal).
  const [iconFor, setIconFor] = useState<Project | null>(null);

  function handleCreate() {
    createProject.mutate(
      { slug, path, notes },
      {
        onSuccess: (created) => {
          setCreating(false);
          setSlug('');
          setPath('');
          setNotes('');
          toast(t.projects.created);
          // Offer the icon picker right away (it browses the new project's own images, so it needs the
          // project to exist first) — same flow as editing a project.
          setIconFor(created);
        },
        onError: (e) => toast(String(e), 'error'),
      }
    );
  }

  function handleUpdate() {
    if (!editProject) return;
    updateProject.mutate(
      { id: editProject.id, path: editPath, notes: editNotes, pr_enabled: editPrEnabled },
      {
        onSuccess: () => { setEditProject(null); toast(t.projects.updated); },
        onError: (e) => toast(String(e), 'error'),
      }
    );
  }

  function handleRemove() {
    if (!removing) return;
    const id = removing.id;
    removeProject.mutate(id, {
      onSuccess: () => {
        setRemoving(null);
        if (selectedId === id) setSelectedId(null);
        toast(t.projects.removed);
      },
      onError: (e) => toast(String(e), 'error'),
    });
  }

  return (
    <>
      <ModuleHeader title={t.page.projects} count={projects.data?.length} icon={FolderGit2}>
        <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>
      </ModuleHeader>

      {projects.isLoading ? <LoadingState variant="cards" />
        : projects.isError ? <ErrorState message={t.projects.loadError} onRetry={() => projects.refetch()} />
        : !projects.data || projects.data.length === 0 ? <EmptyState title={t.projects.empty} icon={FolderGit2} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>} />
        : (
          <div className="@container">
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-3">
            {projects.data.map((p) => {
              const active = selectedId === p.id;
              const status = active && git.data?.isRepo ? git.data.status : null;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(p.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(p.id);
                    }
                  }}
                  onContextMenu={(e) => openCtxMenu(e, p)}
                  className={`card-interactive group flex cursor-pointer gap-3.5 rounded-lg border p-3.5 ${active ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface'}`}
                >
                  <div className="flex shrink-0 items-center">
                    <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border-2 border-border bg-elevated">
                      <ProjectIcon project={p} size={p.icon ? 44 : 24} className="text-text-muted" />
                    </span>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="truncate font-semibold text-text">{p.slug}</span>
                    <span className="flex items-center gap-1 truncate font-mono text-xs text-text-muted"><Folder size={11} className="shrink-0" aria-hidden />{p.path}</span>

                    {active && git.isLoading && <span className="font-mono text-[11px] text-text-muted animate-pulse">{t.common.loading}</span>}
                    {active && git.data && !git.data.isRepo && <Badge tone="muted">{t.projects.notGit}</Badge>}
                    {status && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <Badge tone="accent"><GitBranch size={11} className="mr-1" aria-hidden />{status.branch}</Badge>
                        {status.clean
                          ? <Badge tone="success"><CheckCircle2 size={11} className="mr-1" aria-hidden />{t.projects.clean}</Badge>
                          : <button type="button" onClick={(e) => { e.stopPropagation(); openWorking(); }} title={t.projects.viewChanges} className="transition-opacity hover:opacity-80">
                              <Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(status.dirty))}</Badge>
                            </button>}
                        {status.ahead > 0 && <Badge tone="accent"><ArrowUp size={11} className="mr-0.5" aria-hidden />{status.ahead}</Badge>}
                        {status.behind > 0 && <Badge tone="muted"><ArrowDown size={11} className="mr-0.5" aria-hidden />{status.behind}</Badge>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        )}

      {selectedId && !editingId ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="accent" icon={Code2} onClick={() => openEditor(null)}>{t.projects.openEditor}</Button>
          <Button icon={Pencil} onClick={() => { const p = projects.data?.find((x) => x.id === selectedId); if (p) openEdit(p); }}>{t.projects.editProject}</Button>
        </div>
      ) : null}

      {editingId ? <ProjectEditor key={editingWorking ? 'working' : (editingCommit ?? 'files')} projectId={editingId} initialCommit={editingCommit} initialWorking={editingWorking} onClose={closeEditor} /> : null}

      {selectedId && git.data?.isRepo && (git.data.branches.length > 0 || git.data.commits.length > 0) && (
        <div className="mt-5 flex flex-col gap-5 rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
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
                  <li key={c.hash}>
                    <button
                      type="button"
                      onClick={() => openEditor(c.hash)}
                      title={t.projects.viewCommit}
                      className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border bg-bg px-3 py-2 text-left text-sm transition-colors hover:border-accent/50 hover:bg-elevated"
                    >
                      <GitCommitHorizontal size={12} className="shrink-0 text-text-muted" aria-hidden />
                      <span className="font-mono text-xs text-accent">{c.hash}</span>
                      <span className="min-w-0 flex-1 truncate text-text">{c.subject}</span>
                      <span className="shrink-0 text-xs text-text-muted">{c.author} · {c.relative}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {selectedId && git.isError && <div className="mt-5"><ErrorState message={t.projects.gitError} onRetry={() => git.refetch()} /></div>}

      {creating && (
        <Modal title={t.projects.newProject} onClose={() => setCreating(false)} size="md" icon={FolderGit2}>
          <ModalBody gap={4}>
            <Field label={t.projects.fieldSlug} hint={t.help.projectSlug}>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t.projects.slugPlaceholder} autoFocus />
            </Field>
            <Field label={t.projects.fieldPath} hint={t.help.projectPath}>
              <div className="flex items-center gap-2">
                <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t.projects.pathPlaceholder} className="flex-1 font-mono text-xs" />
                <Button icon={Folder} variant="default" onClick={() => setBrowsing(true)}>{t.projects.browse}</Button>
              </div>
            </Field>
            <Field label={t.projects.fieldNotes} hint={t.help.projectNotes}>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none" />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t.common.cancel}</Button>
            <Button variant="accent" onClick={handleCreate} disabled={createProject.isPending || !slug.trim() || !path.trim()}>{t.projects.create}</Button>
          </ModalFooter>
        </Modal>
      )}

      {editProject && (
        <Modal title={t.projects.editProject} onClose={() => setEditProject(null)} size="md" icon={FolderGit2}>
          <ModalBody gap={4}>
            <Field label={t.projects.fieldSlug} hint={t.help.projectSlugImmutable}>
              <Input value={editProject.slug} disabled className="font-mono text-xs opacity-60" />
            </Field>
            <Field label={t.projects.iconLabel} hint={t.help.projectIcon}>
              {(() => {
                // Live project so the preview reflects an icon just set via the picker (which invalidates ['projects']).
                const live = projects.data?.find((x) => x.id === editProject.id) ?? editProject;
                return (
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated">
                      <ProjectIcon project={live} size={live.icon ? 36 : 22} className="text-text-muted" />
                    </span>
                    <Button icon={ImageIcon} onClick={() => setIconFor(live)}>{t.projects.chooseIcon}</Button>
                    {live.icon ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted" title={live.icon}>{live.icon}</span> : null}
                  </div>
                );
              })()}
            </Field>
            <Field label={t.projects.fieldPath} hint={t.help.projectPath}>
              <Input value={editPath} onChange={(e) => setEditPath(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label={t.projects.fieldNotes} hint={t.help.projectNotes}>
              <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none" />
            </Field>
            <Field label={t.projects.prFlowLabel} hint={t.help.projectPrFlow}>
              <Segmented
                value={editPrEnabled === null ? 'default' : editPrEnabled ? 'on' : 'off'}
                onChange={(v) => setEditPrEnabled(v === 'default' ? null : v === 'on')}
                options={[
                  { value: 'default', label: t.projects.prFlowInherit },
                  { value: 'on', label: t.projects.prFlowOn },
                  { value: 'off', label: t.projects.prFlowOff },
                ]}
              />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="danger" icon={Trash2} onClick={() => { const p = editProject; setEditProject(null); setRemoving(p); }}>{t.projects.removeProject}</Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setEditProject(null)}>{t.common.cancel}</Button>
            <Button variant="accent" onClick={handleUpdate} disabled={updateProject.isPending || !editPath.trim()}>{t.common.save}</Button>
          </ModalFooter>
        </Modal>
      )}

      {browsing && (
        <DirectoryPicker
          initialPath={path}
          onSelect={(p) => { setPath(p); setBrowsing(false); }}
          onClose={() => setBrowsing(false)}
        />
      )}

      {iconFor && <ProjectIconPicker project={iconFor} onClose={() => setIconFor(null)} />}

      {removing && (
        <Modal title={t.projects.removeConfirmTitle} onClose={() => setRemoving(null)} size="sm" icon={AlertTriangle}>
          <ModalBody>
            <p className="text-sm text-text-muted">{t.projects.removeConfirmBody.replace('{slug}', removing.slug)}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>{t.common.cancel}</Button>
            <Button variant="danger" icon={Trash2} onClick={handleRemove} disabled={removeProject.isPending}>{t.projects.removeConfirmBtn}</Button>
          </ModalFooter>
        </Modal>
      )}

      {ctxMenu && <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </>
  );
}
