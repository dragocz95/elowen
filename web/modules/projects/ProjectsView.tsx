'use client';
import { useState } from 'react';
import { FolderGit2, GitBranch, GitCommitHorizontal, Plus, CheckCircle2, AlertTriangle, ArrowUp, ArrowDown, Folder, MoreHorizontal } from 'lucide-react';
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
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { PageFrame } from '../../components/ui/PageFrame';
import { Surface } from '../../components/ui/Surface';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';

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
  const projectActions = (p: Project): ActionMenuItem[] => [
    {
      label: t.projects.ctxOpenEditor,
      icon: Code2,
      onSelect: () => { setSelectedId(p.id); setEditingId(p.id); setEditingCommit(null); setEditingWorking(false); },
    },
    { label: t.projects.ctxEditProject, icon: Pencil, onSelect: () => { setSelectedId(p.id); openEdit(p); } },
    { label: t.projects.ctxCopyPath, icon: Copy, onSelect: () => { void navigator.clipboard.writeText(p.path); toast(t.projects.ctxPathCopied); } },
    { label: t.projects.ctxRemove, icon: Trash2, tone: 'danger', onSelect: () => setRemoving(p) },
  ];
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

  const selectedProject = projects.data?.find((project) => project.id === selectedId) ?? null;

  return (
    <>
      <ModuleHeader title={t.page.projects} count={projects.data?.length} icon={FolderGit2}>
        <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>
      </ModuleHeader>

      <PageFrame width="wide">
        {projects.isLoading ? <LoadingState variant="list" />
          : projects.isError ? <ErrorState message={t.projects.loadError} onRetry={() => projects.refetch()} />
          : !projects.data || projects.data.length === 0 ? <EmptyState title={t.projects.empty} icon={FolderGit2} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>} />
          : (
            <EntityList data-testid="projects-register">
              <MotionPresence>
                {projects.data.map((p) => {
                  const active = selectedId === p.id;
                  return (
                    <MotionLayoutItem key={p.id} layoutId={`project-${p.id}`} role="listitem">
                      <EntityRow
                        role="presentation"
                        selected={active}
                        busy={active && git.isLoading}
                        className="group"
                        onContextMenu={(e) => openCtxMenu(e, p)}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <button
                            type="button"
                            aria-pressed={active}
                            onClick={() => setSelectedId(p.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedId(p.id);
                              }
                            }}
                            className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                          >
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated/70">
                              <ProjectIcon project={p} size={p.icon ? 36 : 21} className="text-text-muted" />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="truncate text-sm font-semibold text-text transition-colors group-hover:text-accent">{p.slug}</span>
                              <span className="flex min-w-0 items-center gap-1 truncate font-mono text-xs text-text-muted">
                                <Folder size={11} className="shrink-0" aria-hidden />
                                <span className="truncate">{p.path}</span>
                              </span>
                              {p.notes ? <span className="truncate text-xs text-text-muted">{p.notes}</span> : null}
                            </span>
                          </button>
                          <ActionMenu
                            label={`${p.slug}: ${t.common.actions}`}
                            items={projectActions(p)}
                            trigger={<MoreHorizontal size={16} aria-hidden />}
                            triggerClassName="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                          />
                        </div>
                      </EntityRow>
                    </MotionLayoutItem>
                  );
                })}
              </MotionPresence>
            </EntityList>
          )}

        <MotionPresence mode="wait">
          {selectedProject ? (
            <MotionLayoutItem key={`project-detail-${selectedProject.id}`}>
              <Surface level="panel" padding="md" radius="md" className="flex min-w-0 flex-col gap-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated/70">
                      <ProjectIcon project={selectedProject} size={selectedProject.icon ? 39 : 22} className="text-text-muted" />
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h2 className="truncate text-base font-semibold text-text">{selectedProject.slug}</h2>
                      <span className="flex min-w-0 items-center gap-1 truncate font-mono text-xs text-text-muted"><Folder size={11} className="shrink-0" aria-hidden />{selectedProject.path}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button variant="accent" icon={Code2} onClick={() => openEditor(null)}>{t.projects.openEditor}</Button>
                    <Button icon={Pencil} onClick={() => openEdit(selectedProject)}>{t.projects.editProject}</Button>
                  </div>
                </div>

                {git.isLoading ? <span className="font-mono text-xs text-text-muted animate-pulse">{t.common.loading}</span> : null}
                {git.data && !git.data.isRepo ? <Badge tone="muted">{t.projects.notGit}</Badge> : null}
                {git.data?.status ? (
                  <div className="flex flex-wrap items-center gap-1.5 border-y border-border/70 py-3">
                    <Badge tone="accent"><GitBranch size={11} className="mr-1" aria-hidden />{git.data.status.branch}</Badge>
                    {git.data.status.clean
                      ? <Badge tone="success"><CheckCircle2 size={11} className="mr-1" aria-hidden />{t.projects.clean}</Badge>
                      : <button type="button" onClick={openWorking} title={t.projects.viewChanges} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
                          <Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge>
                        </button>}
                    {git.data.status.ahead > 0 ? <Badge tone="accent"><ArrowUp size={11} className="mr-0.5" aria-hidden />{git.data.status.ahead}</Badge> : null}
                    {git.data.status.behind > 0 ? <Badge tone="muted"><ArrowDown size={11} className="mr-0.5" aria-hidden />{git.data.status.behind}</Badge> : null}
                  </div>
                ) : null}

                {git.data?.isRepo && git.data.branches.length > 0 ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-medium text-text"><GitBranch size={14} className="text-text-muted" aria-hidden />{t.projects.branches}</h3>
                    <div className="flex flex-wrap gap-2">
                      {git.data.branches.map((branch) => <Badge key={branch.name} tone={branch.current ? 'accent' : 'muted'}>{branch.name}{branch.current ? ' *' : ''}</Badge>)}
                    </div>
                  </section>
                ) : null}

                {git.data?.isRepo && git.data.commits.length > 0 ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-medium text-text"><GitCommitHorizontal size={14} className="text-text-muted" aria-hidden />{t.projects.commits}</h3>
                    <EntityList>
                      {git.data.commits.map((commit) => (
                        <EntityRow key={commit.hash} interactive={false} className="py-0">
                          <button
                            type="button"
                            onClick={() => openEditor(commit.hash)}
                            title={t.projects.viewCommit}
                            className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md px-2 py-3 text-left text-sm transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                          >
                            <GitCommitHorizontal size={12} className="shrink-0 text-text-muted" aria-hidden />
                            <span className="font-mono text-xs text-accent">{commit.hash}</span>
                            <span className="min-w-0 flex-1 truncate text-text">{commit.subject}</span>
                            <span className="shrink-0 text-xs text-text-muted">{commit.author} · {commit.relative}</span>
                          </button>
                        </EntityRow>
                      ))}
                    </EntityList>
                  </section>
                ) : null}

                {git.isError ? <ErrorState message={t.projects.gitError} onRetry={() => git.refetch()} /> : null}
              </Surface>
            </MotionLayoutItem>
          ) : null}
        </MotionPresence>

        {editingId ? <ProjectEditor key={editingWorking ? 'working' : (editingCommit ?? 'files')} projectId={editingId} initialCommit={editingCommit} initialWorking={editingWorking} onClose={closeEditor} /> : null}
      </PageFrame>

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
