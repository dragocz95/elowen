'use client';
import { useDeferredValue, useMemo, useState } from 'react';
import { FolderGit2, GitBranch, GitCommitHorizontal, Plus, CheckCircle2, AlertTriangle, ArrowUp, ArrowDown, Folder, MoreHorizontal, Code2, Copy, Pencil, Trash2, ImageIcon, Search, Github, FileText, Layers3 } from 'lucide-react';
import { useProjects, useProjectGit } from '../../lib/queries';
import { useCreateProject, useUpdateProject, useRemoveProject } from '../../lib/mutations';
import type { Project } from '../../lib/types';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { SelectMenu, type SelectMenuOption } from '../../components/ui/SelectMenu';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { ContextMenu, DIVIDER, type ContextMenuState } from '../../components/ui/ContextMenu';
import { ProjectEditor } from './editor/ProjectEditor';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { ProjectIconPicker } from './ProjectIconPicker';
import { DirectoryPicker } from './DirectoryPicker';
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { DataTable, DataTableCell, DataTableRow } from '../../components/ui/DataTable';
import { WorkspaceDetailRail, WorkspaceMetric, SpatialWorkspaceLayout } from '../../components/ui/WorkspacePrimitives';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';

type ProjectFilter = 'all' | 'inherit' | 'override';

export function ProjectsView() {
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingCommit, setEditingCommit] = useState<string | null>(null);
  const [editingWorking, setEditingWorking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const deferredQuery = useDeferredValue(query);

  const openProjectEditor = (projectId: number | null, commit: string | null, working = false) => {
    if (projectId == null) return;
    setEditingId(projectId);
    setEditingCommit(commit);
    setEditingWorking(working);
    setSelectedId(null);
  };
  const openEditor = (commit: string | null) => openProjectEditor(selectedId, commit);
  const openWorking = () => openProjectEditor(selectedId, null, true);
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
        { label: t.projects.ctxOpenEditor, icon: Code2, onClick: () => openProjectEditor(p.id, null) },
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
      onSelect: () => openProjectEditor(p.id, null),
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

  const filteredProjects = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return (projects.data ?? []).filter((project) => {
      if (filter === 'inherit' && project.pr_enabled !== null) return false;
      if (filter === 'override' && project.pr_enabled === null) return false;
      return !needle || `${project.slug} ${project.path} ${project.notes}`.toLowerCase().includes(needle);
    });
  }, [deferredQuery, filter, projects.data]);

  const summary = useMemo(() => {
    const items = projects.data ?? [];
    return {
      overrides: items.filter((project) => project.pr_enabled !== null).length,
      icons: items.filter((project) => Boolean(project.icon)).length,
      documented: items.filter((project) => Boolean(project.notes.trim())).length,
    };
  }, [projects.data]);

  const selectedProject = projects.data?.find((project) => project.id === selectedId) ?? null;
  const FILTER_OPTIONS: SelectMenuOption<ProjectFilter>[] = [
    { value: 'all', label: t.projects.filterAll, icon: <Layers3 size={14} /> },
    { value: 'inherit', label: t.projects.filterInherited, icon: <Github size={14} /> },
    { value: 'override', label: t.projects.filterOverrides, icon: <GitBranch size={14} /> },
  ];

  const navigateProject = (project: Project, direction: 'next' | 'previous' | 'home' | 'end') => {
    const index = filteredProjects.findIndex((item) => item.id === project.id);
    const next = direction === 'home' ? filteredProjects[0]
      : direction === 'end' ? filteredProjects.at(-1)
        : filteredProjects[index + (direction === 'next' ? 1 : -1)];
    if (!next) return;
    setSelectedId(next.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-project-row="${next.id}"]`)?.focus());
  };

  return (
    <>
      <ModuleHeader title={t.page.projects} count={projects.data?.length} icon={FolderGit2} />
      <SpatialWorkspaceLayout
        hero={{
          eyebrow: t.projects.registry,
          title: t.page.projects,
          count: projects.data?.length ?? 0,
          description: t.projects.workspaceIntro,
          mascotState: projects.isLoading ? 'saving' : projects.isError ? 'error' : 'idle',
          status: !projects.isLoading && !projects.isError ? <span className="workspace-status">{t.projects.registryReady}</span> : undefined,
          action: <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>,
          metrics: <>
            <WorkspaceMetric label={t.projects.metricProjects} value={projects.data?.length ?? 0} icon={FolderGit2} />
            <WorkspaceMetric label={t.projects.metricOverrides} value={summary.overrides} icon={GitBranch} />
            <WorkspaceMetric label={t.projects.metricIcons} value={summary.icons} icon={ImageIcon} />
            <WorkspaceMetric label={t.projects.metricDocumented} value={summary.documented} icon={FileText} />
          </>,
        }}
      >
        <ControlSurfaceDocument>
          <ControlSurfaceToolbar className="flex-wrap">
            <div className="relative min-w-[15rem] flex-1">
              <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.projects.searchPlaceholder} className="pl-9" />
            </div>
            <SelectMenu value={filter} onChange={setFilter} options={FILTER_OPTIONS} label={t.projects.filterLabel} className="min-w-[11rem]" />
          </ControlSurfaceToolbar>

          {projects.isLoading ? <ControlSurfaceState><LoadingState variant="list" /></ControlSurfaceState>
            : projects.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.projects.loadError} onRetry={() => projects.refetch()} /></ControlSurfaceState>
            : !projects.data || projects.data.length === 0 ? <ControlSurfaceState><EmptyState title={t.projects.empty} icon={FolderGit2} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button>} /></ControlSurfaceState>
            : (
              <ControlSurfaceRegister className="workspace-master-detail" data-detail={selectedProject != null}>
                <div className="min-w-0">
                  {filteredProjects.length === 0 ? (
                    <ControlSurfaceState><EmptyState title={t.projects.noMatches} icon={Search} /></ControlSurfaceState>
                  ) : (
                    <DataTable ariaLabel={t.projects.tableLabel} columns="minmax(13rem,1.2fr) minmax(15rem,1.5fr) minmax(10rem,1fr) 8rem 3rem" compactColumns="minmax(0,1fr) 3rem" data-testid="projects-register">
                      <DataTableRow header>
                        <DataTableCell header>{t.projects.columnProject}</DataTableCell>
                        <DataTableCell header priority="wide">{t.projects.columnPath}</DataTableCell>
                        <DataTableCell header priority="wide">{t.projects.columnNotes}</DataTableCell>
                        <DataTableCell header priority="wide">{t.projects.columnPrFlow}</DataTableCell>
                        <DataTableCell header><span className="sr-only">{t.common.actions}</span></DataTableCell>
                      </DataTableRow>
                      {filteredProjects.map((project) => {
                        const active = selectedId === project.id;
                        return (
                          <DataTableRow
                            key={project.id}
                            selected={active}
                            interactive
                            tabIndex={0}
                            aria-selected={active}
                            data-project-row={project.id}
                            className="group cursor-pointer"
                            onClick={() => setSelectedId(project.id)}
                            onContextMenu={(event) => openCtxMenu(event, project)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(project.id); }
                              if (event.key === 'ArrowDown') { event.preventDefault(); navigateProject(project, 'next'); }
                              if (event.key === 'ArrowUp') { event.preventDefault(); navigateProject(project, 'previous'); }
                              if (event.key === 'Home') { event.preventDefault(); navigateProject(project, 'home'); }
                              if (event.key === 'End') { event.preventDefault(); navigateProject(project, 'end'); }
                            }}
                          >
                            <DataTableCell className="flex items-center gap-3">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated/60">
                                <ProjectIcon project={project} size={project.icon ? 32 : 18} className="text-text-muted" />
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-text transition-colors group-hover:text-accent">{project.slug}</span>
                                <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted lg:hidden">{project.path}</span>
                              </span>
                            </DataTableCell>
                            <DataTableCell priority="wide" className="truncate font-mono text-xs text-text-muted"><Folder size={11} className="mr-1.5 inline" aria-hidden />{project.path}</DataTableCell>
                            <DataTableCell priority="wide" className="truncate text-xs text-text-muted">{project.notes || '—'}</DataTableCell>
                            <DataTableCell priority="wide"><span className="text-xs text-text-muted">{project.pr_enabled === null ? t.projects.prFlowInherit : project.pr_enabled ? t.projects.prFlowOn : t.projects.prFlowOff}</span></DataTableCell>
                            <DataTableCell onClick={(event) => event.stopPropagation()}>
                              <ActionMenu
                                label={`${project.slug}: ${t.common.actions}`}
                                items={projectActions(project)}
                                trigger={<MoreHorizontal size={16} aria-hidden />}
                                triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted opacity-70 transition-colors hover:bg-elevated hover:text-text group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                              />
                            </DataTableCell>
                          </DataTableRow>
                        );
                      })}
                    </DataTable>
                  )}
                </div>

                {selectedProject ? (
                  <WorkspaceDetailRail label={t.projects.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)}>
                    <div className="flex min-w-0 items-center gap-3 border-b border-border/70 pb-4">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated/60">
                        <ProjectIcon project={selectedProject} size={selectedProject.icon ? 39 : 22} className="text-text-muted" />
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold text-text">{selectedProject.slug}</h2>
                        <span className="block truncate font-mono text-[11px] text-text-muted">{selectedProject.path}</span>
                      </div>
                    </div>

                    {selectedProject.notes ? <p className="border-b border-border/70 py-4 text-xs leading-relaxed text-text-muted">{selectedProject.notes}</p> : null}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 py-3">
                      <button type="button" onClick={() => openEditor(null)} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-text"><Code2 size={13} aria-hidden />{t.projects.openEditor}</button>
                      <button type="button" onClick={() => openEdit(selectedProject)} className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text"><Pencil size={13} aria-hidden />{t.projects.editProject}</button>
                    </div>

                    {git.isLoading ? <span className="block py-4 font-mono text-xs text-text-muted animate-pulse">{t.common.loading}</span> : null}
                    {git.data && !git.data.isRepo ? <div className="py-4"><Badge tone="muted">{t.projects.notGit}</Badge></div> : null}
                    {git.data?.status ? (
                      <section className="border-b border-border/70 py-4">
                        <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-text"><Github size={14} className="text-text-muted" aria-hidden />{t.projects.git}</h3>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="accent"><GitBranch size={11} className="mr-1" aria-hidden />{git.data.status.branch}</Badge>
                          {git.data.status.clean
                            ? <Badge tone="success"><CheckCircle2 size={11} className="mr-1" aria-hidden />{t.projects.clean}</Badge>
                            : <button type="button" onClick={openWorking} title={t.projects.viewChanges} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"><Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge></button>}
                          {git.data.status.ahead > 0 ? <Badge tone="accent"><ArrowUp size={11} className="mr-0.5" aria-hidden />{git.data.status.ahead}</Badge> : null}
                          {git.data.status.behind > 0 ? <Badge tone="muted"><ArrowDown size={11} className="mr-0.5" aria-hidden />{git.data.status.behind}</Badge> : null}
                        </div>
                      </section>
                    ) : null}

                    {git.data?.isRepo && git.data.branches.length > 0 ? (
                      <section className="border-b border-border/70 py-4">
                        <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-text"><GitBranch size={14} className="text-text-muted" aria-hidden />{t.projects.branches}</h3>
                        <div className="flex flex-wrap gap-1.5">{git.data.branches.map((branch) => <Badge key={branch.name} tone={branch.current ? 'accent' : 'muted'}>{branch.name}{branch.current ? ' *' : ''}</Badge>)}</div>
                      </section>
                    ) : null}

                    {git.data?.isRepo && git.data.commits.length > 0 ? (
                      <section className="py-4">
                        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-text"><GitCommitHorizontal size={14} className="text-text-muted" aria-hidden />{t.projects.commits}</h3>
                        <EntityList>
                          {git.data.commits.map((commit) => (
                            <EntityRow key={commit.hash} interactive={false} className="py-0">
                              <button type="button" onClick={() => openEditor(commit.hash)} title={t.projects.viewCommit} className="flex w-full min-w-0 flex-col gap-1 px-1 py-3 text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
                                <span className="flex min-w-0 items-center gap-2"><span className="font-mono text-[11px] text-accent">{commit.hash}</span><span className="min-w-0 flex-1 truncate text-xs text-text">{commit.subject}</span></span>
                                <span className="text-[10px] text-text-muted">{commit.author} · {commit.relative}</span>
                              </button>
                            </EntityRow>
                          ))}
                        </EntityList>
                      </section>
                    ) : null}
                    {git.isError ? <ErrorState message={t.projects.gitError} onRetry={() => git.refetch()} /> : null}
                  </WorkspaceDetailRail>
                ) : null}
              </ControlSurfaceRegister>
            )}
        </ControlSurfaceDocument>
      </SpatialWorkspaceLayout>

      {editingId ? (
        <Modal title={t.projects.editorTitle} size="lg" icon={Code2} onClose={closeEditor}>
          <ProjectEditor
            key={editingWorking ? 'working' : (editingCommit ?? 'files')}
            projectId={editingId}
            initialCommit={editingCommit}
            initialWorking={editingWorking}
            fill
          />
        </Modal>
      ) : null}

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
