'use client';
import { useDeferredValue, useMemo, useState } from 'react';
import { FolderGit2, GitBranch, GitCommitHorizontal, Plus, CheckCircle2, AlertTriangle, ArrowUp, ArrowDown, Folder, MoreHorizontal, Code2, Copy, Pencil, Trash2, ImageIcon, Search, FileText } from 'lucide-react';
import { useProjects, useProjectSummaries, useProjectGit, usePluginPresent, useMe } from '../../lib/queries';
import { useCreateProject, useUpdateProject, useRemoveProject } from '../../lib/mutations';
import type { Project } from '../../lib/types';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { EmptyState, ErrorState, LoadingLine, LoadingState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../../components/ui/ContextMenu';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { ProjectIconPicker } from './ProjectIconPicker';
import { DirectoryPicker } from './DirectoryPicker';
import { ProjectDetailTabs } from './ProjectDetailTabs';
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../../components/ui/DataTable';
import { WorkspaceDetailRail, WorkspaceMetric } from '../../components/ui/WorkspacePrimitives';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';
import { copyText } from '../../lib/clipboard';
import { Avatar } from '../../components/ui/Avatar';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import type { ProjectSummary } from '../../lib/types';

function ProjectSummaryCell({ summary, membersLabel }: { summary?: ProjectSummary; membersLabel: string }) {
  const members = summary?.members;
  const indicators = summary?.indicators ?? [];
  if ((!members || members.total === 0) && indicators.length === 0) return <span className="text-xs text-text-muted">—</span>;
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {members && members.total > 0 ? (
        <div className="flex shrink-0 items-center" aria-label={membersLabel.replace('{n}', String(members.total))}>
          <div className="flex -space-x-1.5">
            {members.samples.map((user) => <span key={user.id} className="rounded-full ring-2 ring-surface" title={user.name || user.username}><Avatar user={user} size={22} /></span>)}
          </div>
          <span className="ml-1.5 text-[11px] font-semibold text-text-muted">{members.total}</span>
        </div>
      ) : null}
      {indicators.length > 0 ? (
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {indicators.map((indicator, index) => {
            const Icon = pluginLucideIcon(indicator.icon);
            return (
              <span key={`${indicator.plugin}:${indicator.label}:${index}`} title={indicator.value ? `${indicator.label}: ${indicator.value}` : indicator.label}>
                <Badge tone={indicator.tone ?? 'muted'}>
                  <Icon size={11} className="mr-1" aria-hidden />
                  <span className="max-w-28 truncate">{indicator.label}</span>
                  {indicator.value ? <span className="ml-1 font-semibold">{indicator.value}</span> : null}
                </Badge>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectsView() {
  const projects = useProjects();
  const projectSummaries = useProjectSummaries();
  const editorEnabled = usePluginPresent('editor');
  // Registering, editing and removing a project is admin-only on the daemon (notAdmin guards POST,
  // PATCH and DELETE /projects). Offering those actions to a member produced a button that could only
  // ever answer 403, and implied members hand themselves new roots -- a project IS the path boundary
  // for a non-admin, so it is an admin who assigns them.
  const isAdmin = useMe().data?.user?.is_admin ?? false;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const openProjectEditor = (projectId: number | null, commit: string | null, working = false) => {
    if (projectId == null || !editorEnabled) return;
    const params = new URLSearchParams({ project: String(projectId) });
    if (commit) params.set('commit', commit);
    if (working) params.set('working', '1');
    window.location.assign(`/p/editor?${params}`);
  };
  const openEditor = (commit: string | null) => openProjectEditor(selectedId, commit);
  const openWorking = () => openProjectEditor(selectedId, null, true);
  const git = useProjectGit(selectedId);

  const { toast } = useToast();
  const { t } = useTranslation();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const removeProject = useRemoveProject();
  // Removal detaches the project from Elowen but never touches files on disk.
  const [removing, setRemoving] = useState<Project | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  function openCtxMenu(e: React.MouseEvent, p: Project) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: projectActionGroups(p).flatMap((group, i): MenuEntry[] => [
        ...(i > 0 ? [DIVIDER] : []),
        ...group.map((action): MenuEntry => ({
          label: action.label,
          icon: action.icon,
          onClick: action.onSelect,
          danger: action.tone === 'danger',
        })),
      ]),
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
  const openEdit = (p: Project) => { setEditProject(p); setEditPath(p.path); setEditNotes(p.notes); };
  // The single source of truth for a project's actions, offered identically by the row's hover menu and by
  // the right-click menu. Grouped rather than flat because only the right-click menu draws dividers, and a
  // second copy of the list is exactly how the two menus drifted apart before.
  const projectActionGroups = (p: Project): ActionMenuItem[][] => [
    [
      ...(editorEnabled ? [{ label: t.projects.ctxOpenEditor, icon: Code2, onSelect: () => openProjectEditor(p.id, null) }] : []),
      ...(isAdmin ? [{ label: t.projects.ctxEditProject, icon: Pencil, onSelect: () => { setSelectedId(p.id); openEdit(p); } }] : []),
    ],
    [{ label: t.projects.ctxCopyPath, icon: Copy, onSelect: () => { void copyText(p.path).then((ok) => { if (ok) toast(t.projects.ctxPathCopied); else toast(t.projects.copyFailed, 'error'); }); } }],
    ...(isAdmin ? [[{ label: t.projects.ctxRemove, icon: Trash2, tone: 'danger' as const, onSelect: () => setRemoving(p) }]] : []),
  ];
  const projectActions = (p: Project): ActionMenuItem[] => projectActionGroups(p).flat();
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
          // The picker reads through the optional editor's project-file routes.
          if (editorEnabled) setIconFor(created);
        },
        onError: (e) => toast(String(e), 'error'),
      }
    );
  }

  function handleUpdate() {
    if (!editProject) return;
    updateProject.mutate(
      { id: editProject.id, path: editPath, notes: editNotes },
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
    return (projects.data ?? []).filter((project) => !needle || `${project.slug} ${project.path} ${project.notes}`.toLowerCase().includes(needle));
  }, [deferredQuery, projects.data]);

  const summary = useMemo(() => {
    const items = projects.data ?? [];
    return {
      icons: items.filter((project) => Boolean(project.icon)).length,
      documented: items.filter((project) => Boolean(project.notes.trim())).length,
    };
  }, [projects.data]);

  const selectedProject = projects.data?.find((project) => project.id === selectedId) ?? null;
  const summariesByProject = useMemo(() => new Map((projectSummaries.data ?? []).map((item) => [item.projectId, item])), [projectSummaries.data]);

  const navigateProject = (project: Project, direction: 'next' | 'previous' | 'home' | 'end') => {
    const index = filteredProjects.findIndex((item) => item.id === project.id);
    const next = direction === 'home' ? filteredProjects[0]
      : direction === 'end' ? filteredProjects.at(-1)
        : filteredProjects[index + (direction === 'next' ? 1 : -1)];
    if (!next) return;
    setSelectedId(next.id);
    // The row itself is no longer a tab stop — its open button is, so that is what receives focus.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-project-row="${next.id}"] .data-table-row-open`)?.focus());
  };

  return (
    <>
      <ModuleHeader title={t.page.projects} count={projects.data?.length} icon={FolderGit2} />
      <WorkspaceShell
        variant="register"
        hero={{
          eyebrow: t.projects.registry,
          title: t.page.projects,
          count: projects.data?.length ?? 0,
          description: t.projects.workspaceIntro,
          mascot: projects.isLoading ? 'saving' : projects.isError ? 'error' : 'idle',
          status: !projects.isLoading && !projects.isError ? <span className="workspace-status">{t.projects.registryReady}</span> : undefined,
          action: isAdmin ? <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button> : undefined,
          metrics: <>
            <WorkspaceMetric label={t.projects.metricProjects} value={projects.data?.length ?? 0} icon={FolderGit2} />
            <WorkspaceMetric label={t.projects.metricIcons} value={summary.icons} icon={ImageIcon} />
            <WorkspaceMetric label={t.projects.metricDocumented} value={summary.documented} icon={FileText} />
          </>,
        }}
      >
        <ControlSurfaceDocument>
          <ControlSurfaceToolbar>
            <RegisterSearch
              value={query}
              onChange={setQuery}
              placeholder={t.projects.searchPlaceholder}
              label={t.projects.searchLabel}
              onClear={() => setQuery('')}
              clearLabel={t.projects.searchClear}
            />
          </ControlSurfaceToolbar>

          {projects.isLoading ? <ControlSurfaceState><LoadingState variant="list" /></ControlSurfaceState>
            : projects.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.projects.loadError} onRetry={() => projects.refetch()} /></ControlSurfaceState>
            : !projects.data || projects.data.length === 0 ? <ControlSurfaceState><EmptyState title={t.projects.empty} icon={FolderGit2} action={isAdmin ? <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button> : undefined} /></ControlSurfaceState>
            : (
              <ControlSurfaceRegister className="workspace-master-detail" data-detail={selectedProject != null}>
                <div className="min-w-0">
                  {filteredProjects.length === 0 ? (
                    <ControlSurfaceState><EmptyState title={t.projects.noMatches} icon={Search} /></ControlSurfaceState>
                  ) : (
                    <DataTable ariaLabel={t.projects.tableLabel} columns="minmax(13rem,1.2fr) minmax(15rem,1.5fr) minmax(14rem,1.2fr) 3rem 1.25rem" compactColumns="minmax(0,1fr) 3rem 1.25rem" data-testid="projects-register">
                      <DataTableRow header>
                        <DataTableCell header lines={1}>{t.projects.columnProject}</DataTableCell>
                        <DataTableCell header priority="wide" lines={1}>{t.projects.columnPath}</DataTableCell>
                        <DataTableCell header priority="wide" lines={1}>{t.projects.columnSummary}</DataTableCell>
                        {/* The chevron track carries no header of its own: the cell is decorative, and the
                            column the row's open control lives in is named by DataTableRow itself. */}
                        <DataTableCell header labelHidden lines={1}>{t.common.actions}</DataTableCell>
                      </DataTableRow>
                      {filteredProjects.map((project) => {
                        const active = selectedId === project.id;
                        return (
                          <DataTableRow
                            key={project.id}
                            selected={active}
                            aria-selected={active}
                            data-project-row={project.id}
                            className="group cursor-pointer"
                            onOpen={() => setSelectedId(project.id)}
                            openLabel={t.projects.openProject.replace('{slug}', project.slug)}
                            onContextMenu={(event) => openCtxMenu(event, project)}
                            // Enter and Space belong to the row's own open button now. Only the roving
                            // arrow/Home/End navigation is left, and it still lives on the row because
                            // that is where a keystroke aimed at any cell bubbles to.
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowDown') { event.preventDefault(); navigateProject(project, 'next'); }
                              if (event.key === 'ArrowUp') { event.preventDefault(); navigateProject(project, 'previous'); }
                              if (event.key === 'Home') { event.preventDefault(); navigateProject(project, 'home'); }
                              if (event.key === 'End') { event.preventDefault(); navigateProject(project, 'end'); }
                            }}
                          >
                            {/* The path is the cell's title rather than a second stacked line: a register
                                whose rows measure one height is what makes it scannable, and the path has
                                its own column plus the detail rail one tap away. */}
                            <DataTableCell lines={1} title={project.path} className="flex items-center gap-3">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated/60">
                                <ProjectIcon project={project} size={project.icon ? 28 : 16} className="text-text-muted" />
                              </span>
                              <span className="min-w-0 truncate text-sm font-semibold text-text transition-colors group-hover:text-accent">{project.slug}</span>
                            </DataTableCell>
                            <DataTableCell priority="wide" lines={1} title={project.path} className="font-mono text-xs text-text-muted"><Folder size={11} className="mr-1.5 inline" aria-hidden />{project.path}</DataTableCell>
                            <DataTableCell priority="wide" lines="auto"><ProjectSummaryCell summary={summariesByProject.get(project.id)} membersLabel={t.projects.membersCount} /></DataTableCell>
                            <DataTableCell lines="auto" onClick={(event) => event.stopPropagation()}>
                              <ActionMenu
                                label={`${project.slug}: ${t.common.actions}`}
                                items={projectActions(project)}
                                trigger={<MoreHorizontal size={16} aria-hidden />}
                                triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted opacity-70 transition-colors hover:bg-elevated hover:text-text group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                              />
                            </DataTableCell>
                            <DataTableChevronCell />
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

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 py-3">
                      {editorEnabled ? <button type="button" onClick={() => openEditor(null)} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-text"><Code2 size={13} aria-hidden />{t.projects.openEditor}</button> : null}
                      {isAdmin ? <button type="button" onClick={() => openEdit(selectedProject)} className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text"><Pencil size={13} aria-hidden />{t.projects.editProject}</button> : null}
                    </div>

                    <ProjectDetailTabs project={selectedProject} isAdmin={isAdmin} overview={<>
                      {selectedProject.notes ? <p className="border-b border-border/70 py-4 text-xs leading-relaxed text-text-muted">{selectedProject.notes}</p> : null}
                      {git.isLoading ? <LoadingLine /> : null}
                      {git.data && !git.data.isRepo ? <div className="py-4"><Badge tone="muted">{t.projects.notGit}</Badge></div> : null}
                      {git.data?.status ? (
                        <section className="border-b border-border/70 py-4">
                          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-text"><FolderGit2 size={14} className="text-text-muted" aria-hidden />{t.projects.git}</h3>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="accent"><GitBranch size={11} className="mr-1" aria-hidden />{git.data.status.branch}</Badge>
                            {git.data.status.clean
                              ? <Badge tone="success"><CheckCircle2 size={11} className="mr-1" aria-hidden />{t.projects.clean}</Badge>
                              : editorEnabled ? <button type="button" onClick={openWorking} title={t.projects.viewChanges} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"><Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge></button>
                              : <Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge>}
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
                                {editorEnabled ? <button type="button" onClick={() => openEditor(commit.hash)} title={t.projects.viewCommit} className="flex w-full min-w-0 flex-col gap-1 px-1 py-3 text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
                                  <span className="flex min-w-0 items-center gap-2"><span className="font-mono text-[11px] text-accent">{commit.hash}</span><span className="min-w-0 flex-1 truncate text-xs text-text">{commit.subject}</span></span>
                                  <span className="text-[10px] text-text-muted">{commit.author} · {commit.relative}</span>
                                </button> : <div className="flex min-w-0 flex-col gap-1 px-1 py-3">
                                  <span className="flex min-w-0 items-center gap-2"><span className="font-mono text-[11px] text-accent">{commit.hash}</span><span className="min-w-0 flex-1 truncate text-xs text-text">{commit.subject}</span></span>
                                  <span className="text-[10px] text-text-muted">{commit.author} · {commit.relative}</span>
                                </div>}
                              </EntityRow>
                            ))}
                          </EntityList>
                        </section>
                      ) : null}
                      {git.isError ? <ErrorState message={t.projects.gitError} onRetry={() => git.refetch()} /> : null}
                    </>} />
                  </WorkspaceDetailRail>
                ) : null}
              </ControlSurfaceRegister>
            )}
        </ControlSurfaceDocument>
      </WorkspaceShell>

      {creating && (
        <Modal title={t.projects.newProject} onClose={() => setCreating(false)} size="md" icon={FolderGit2}>
          <ModalBody gap={4}>
            {/* Slug and path are what "Create" already gates on. The path field is a row of two controls,
                so only the function child can say WHICH of them the required state belongs to. */}
            <Field label={t.projects.fieldSlug} hint={t.help.projectSlug} required>
              {(control) => <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t.projects.slugPlaceholder} autoFocus {...control} />}
            </Field>
            <Field label={t.projects.fieldPath} hint={t.help.projectPath} required>
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t.projects.pathPlaceholder} className="flex-1 font-mono text-xs" {...control} />
                  <Button icon={Folder} variant="default" onClick={() => setBrowsing(true)}>{t.projects.browse}</Button>
                </div>
              )}
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
                    {editorEnabled ? <Button icon={ImageIcon} onClick={() => setIconFor(live)}>{t.projects.chooseIcon}</Button> : null}
                    {live.icon ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted" title={live.icon}>{live.icon}</span> : null}
                  </div>
                );
              })()}
            </Field>
            <Field label={t.projects.fieldPath} hint={t.help.projectPath} required>
              {(control) => <Input value={editPath} onChange={(e) => setEditPath(e.target.value)} className="font-mono text-xs" {...control} />}
            </Field>
            <Field label={t.projects.fieldNotes} hint={t.help.projectNotes}>
              <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none" />
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

      {editorEnabled && iconFor && <ProjectIconPicker project={iconFor} onClose={() => setIconFor(null)} />}

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
