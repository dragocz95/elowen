'use client';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ElowenApiError, apiErrorMessage, elowenClient } from '../../lib/elowenClient';
import { SelectMenu } from '../../components/ui/SelectMenu';
import { FolderGit2, GitBranch, GitCommitHorizontal, Plus, CheckCircle2, AlertTriangle, ArrowUp, ArrowDown, Folder, Code2, Copy, Pencil, Trash2, ImageIcon, Search, FileText } from 'lucide-react';
import { useProjects, useProjectSummaries, useProjectGit, useProjectEnvironmentState, usePluginPresent, useMe } from '../../lib/queries';
import { useAdoptProject, useCreateProject, useUpdateProject, useRemoveProject } from '../../lib/mutations';
import type { Project } from '../../lib/types';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { EmptyState, ErrorState, LoadingLine, LoadingState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../../components/ui/ContextMenu';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { ProjectIconPicker } from './ProjectIconPicker';
import { DirectoryPicker } from './DirectoryPicker';
import { ProjectDetailTabs } from './ProjectDetailTabs';
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { type ActionMenuItem } from '../../components/ui/ActionMenu';
import { WorkspaceDetailRail, WorkspaceMetric } from '../../components/ui/WorkspacePrimitives';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState } from '../../components/ui/ControlSurface';
import { copyText } from '../../lib/clipboard';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { OperationProgressDialog } from '../../components/ui/OperationProgressDialog';
import { useEnvironmentOperationWindow } from '../../lib/useEnvironmentOperation';
import { requestEnvironmentAction } from '../../lib/environmentActions';
import { usePluginProjectRows } from '../../lib/pluginProjectRows';
import { ProjectCard, type ProjectCardLabels } from './ProjectCard';

export function ProjectsView() {
  const projects = useProjects();
  const projectSummaries = useProjectSummaries();
  const editorEnabled = usePluginPresent('editor');
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const canCreate = isAdmin || me.data?.user?.can_create_projects === true;
  const canManage = (project: Project) => (isAdmin || project.executionKind === 'managed') && project.lifecycle !== 'deleting';
  const [executionKind, setExecutionKind] = useState<'managed' | 'host'>('managed');
  const qc = useQueryClient();
  const defaultProject = useMutation({
    mutationFn: elowenClient.defaultProject,
    onSuccess: async (project) => { await qc.invalidateQueries({ queryKey: ['projects'] }); setSelectedId(project.id); },
    onError: (error) => toast(apiErrorMessage(error), 'error'),
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const openedUrlProject = useRef(false);
  useEffect(() => {
    if (openedUrlProject.current || !projects.data) return;
    const value = new URLSearchParams(window.location.search).get('project');
    if (value === null) { openedUrlProject.current = true; return; }
    const id = Number(value);
    if (Number.isSafeInteger(id) && projects.data.some((project) => project.id === id)) setSelectedId(id);
    openedUrlProject.current = true;
  }, [projects.data]);
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
  const selectedProject = projects.data?.find((project) => project.id === selectedId) ?? null;
  // A managed repository is available only while its environment is running. Reading the environment's
  // state first keeps restore, teardown and recovery invalidations from repeatedly asking Git for a guest
  // that cannot answer yet. Host projects continue to read directly.
  const environment = useProjectEnvironmentState(selectedProject?.executionKind === 'managed' ? selectedId : null);
  const git = useProjectGit(selectedId, selectedProject?.executionKind !== 'managed' || environment.data?.environment.state === 'running');

  const { toast } = useToast();
  const { t } = useTranslation();
  const s = t.projects;
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const adoptProject = useAdoptProject();
  const removeProject = useRemoveProject();
  const [adoption, setAdoption] = useState<{ project: Project; undo: boolean } | null>(null);
  // Host removal detaches metadata; managed removal requests durable environment teardown.
  const [removing, setRemoving] = useState<Project | null>(null);
  // What a finished teardown leaves behind, whether or not its window was on screen when it finished: the
  // register stops showing a project that is gone, and the person is told it happened. Dismissing the
  // window is not a cancel, so this may not hang off the dialog alone.
  const deletion = useEnvironmentOperationWindow(({ projectId }) => {
    setSelectedId((current) => current === projectId ? null : current);
    toast(t.projects.removed);
  });
  // The start a managed project's creation implies, followed in the same shared progress window. Its
  // success is what makes the new project's environment state true, so the register is re-read.
  const creationStart = useEnvironmentOperationWindow(() => { void qc.invalidateQueries({ queryKey: ['projects'] }); });
  const removePendingRef = useRef(false);
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
          disabled: action.disabled === true,
        })),
      ]),
    });
  }

  const [slug, setSlug] = useState('');
  const [path, setPath] = useState('');
  const [notes, setNotes] = useState('');
  // One picker serves both forms; its target decides which draft receives the selected folder.
  const [browseTarget, setBrowseTarget] = useState<'create' | 'edit' | null>(null);

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
      ...(canManage(p) ? [{ label: t.projects.ctxEditProject, icon: Pencil, onSelect: () => { setSelectedId(p.id); openEdit(p); } }] : []),
    ],
    // A managed project has no host path, but it does have a path: the guest root its own terminal,
    // editor and executions all work from. Copying that is the same useful action, so the menu offers it
    // rather than going a member short of what a host project gets.
    // What a plugin says this row can be DONE to — the environment's start/stop/restart/snapshot for a
    // managed project. They used to be four buttons inside the environment drawer, two screens away from
    // the register that shows the project, and they belong to the row for the same reason removal does:
    // one place per decision. The items are the plugin's, in both menus, enabled by the state it reports.
    ...(pluginRowActions(p).length > 0 ? [pluginRowActions(p).map((action): ActionMenuItem => ({
      id: `${action.plugin}:${action.id}`,
      label: action.label,
      icon: pluginLucideIcon(action.icon),
      ...(action.disabled ? { disabled: true } : {}),
      ...(action.tone === 'danger' ? { tone: 'danger' as const } : {}),
      onSelect: action.onSelect,
    }))] : []),
    // A managed project has no host path: what it copies is the directory it is mounted at inside its own
    // environment, which the daemon serves rather than the client deriving it from the slug.
    [{ label: t.projects.ctxCopyPath, icon: Copy, onSelect: () => { void copyText(p.guestRoot ?? p.path).then((ok) => { if (ok) toast(t.projects.ctxPathCopied); else toast(t.projects.copyFailed, 'error'); }); } }],
    // Removal lives here for EVERY project. A managed one used to be deleted from a button of its own
    // inside the environment panel, so the same decision sat in two unrelated places depending on where
    // the project happened to run. The confirmation below still tells a managed project the truth about
    // its environment, and the request still travels the same durable teardown the panel used.
    ...(canManage(p) ? [[{ label: t.projects.ctxRemove, icon: Trash2, tone: 'danger' as const, onSelect: () => setRemoving(p) }]] : []),
  ];
  const projectActions = (p: Project): ActionMenuItem[] => projectActionGroups(p).flat();
  // Project whose icon is being chosen (drives the icon-picker modal, stacked over the edit modal).
  const [iconFor, setIconFor] = useState<Project | null>(null);

  function handleCreate() {
    createProject.mutate(
      executionKind === 'managed' ? { slug: slug.trim(), notes, executionKind } : { slug, path, notes },
      {
        onSuccess: (created) => {
          setCreating(false);
          setSlug('');
          setPath('');
          setNotes('');
          toast(t.projects.created);
          // Creating a managed project starts its environment, so the window that follows that start
          // opens here rather than leaving the person to press start on a project they just made.
          if (created.environmentOperationId) creationStart.follow(created.environmentOperationId, created.id);
          // The picker reads through the optional editor's project-file routes, which serve a managed
          // project from its own guest filesystem, so the offer does not depend on where it runs.
          if (editorEnabled) setIconFor(created);
        },
        onError: (e) => toast(apiErrorMessage(e), 'error'),
      }
    );
  }

  function handleUpdate() {
    if (!editProject) return;
    updateProject.mutate(
      { id: editProject.id, ...(editProject.executionKind === 'managed' ? {} : { path: editPath }), notes: editNotes },
      {
        onSuccess: () => { setEditProject(null); toast(t.projects.updated); },
        onError: (e) => toast(apiErrorMessage(e), 'error'),
      }
    );
  }

  async function handleAdoption(): Promise<void> {
    const target = adoption;
    if (!target) return;
    await adoptProject.mutateAsync({ id: target.project.id, undo: target.undo });
    setAdoption(null);
    toast(target.undo ? s.adoptionUndone : s.adopted);
  }

  async function handleRemove(): Promise<void> {
    const target = removing;
    if (!target || removePendingRef.current) return;
    removePendingRef.current = true;
    const id = target.id;
    try {
      const result = await removeProject.mutateAsync(id);
      setRemoving((current) => current?.id === id ? null : current);
      setEditProject((current) => current?.id === id ? null : current);
      setSelectedId((current) => current === id && !('operation' in result) ? null : current);
      // A managed project's deletion is a durable operation, not a request that finished. Following it
      // is the difference between "deleting…" as a toast that never updates and a window that says which
      // of the six teardown steps is running and stops on the one that failed.
      if ('operation' in result) deletion.follow(result.operation.id, id);
      else toast(t.projects.removed);
    } catch (e) {
      toast(apiErrorMessage(e), 'error');
    } finally {
      removePendingRef.current = false;
    }
  }

  const filteredProjects = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return (projects.data ?? []).filter((project) => !needle || `${project.slug} ${project.path} ${project.notes}`.toLowerCase().includes(needle));
  }, [deferredQuery, projects.data]);

  // The register asks the plugins that own something about these rows what they have to say. Core keeps
  // the row, the path and the menu; the environment behind a managed project is the sandbox plugin's,
  // states and lifecycle actions included, so none of its vocabulary lives here.
  //
  // They are asked about the account's WHOLE authorized list, not the rows the search leaves. The set a
  // plugin observes is what it keys its own reads on, so narrowing it per keystroke gave every filter
  // state a cache entry and a batch request of its own — and it took the open drawer's project out of the
  // input entirely, blanking the resource panel of a project that is still on screen. The daemon has
  // already decided what this account may see; the search box is a view of that list, not a second
  // authorization over it.
  const observedProjects = useMemo(() => projects.data ?? [], [projects.data]);
  const pluginRows = usePluginProjectRows(observedProjects);
  const pluginRowActions = (project: Project) => pluginRows.actionsFor(project.id);

  const summary = useMemo(() => {
    const items = projects.data ?? [];
    return {
      icons: items.filter((project) => Boolean(project.icon)).length,
      documented: items.filter((project) => Boolean(project.notes.trim())).length,
    };
  }, [projects.data]);

  const summariesByProject = useMemo(() => new Map((projectSummaries.data ?? []).map((item) => [item.projectId, item])), [projectSummaries.data]);

  const navigateProject = (project: Project, direction: 'next' | 'previous' | 'home' | 'end') => {
    const index = filteredProjects.findIndex((item) => item.id === project.id);
    const next = direction === 'home' ? filteredProjects[0]
      : direction === 'end' ? filteredProjects.at(-1)
        : filteredProjects[index + (direction === 'next' ? 1 : -1)];
    if (!next) return;
    setSelectedId(next.id);
    // The card itself is not a tab stop — its open button is, so that is what receives focus.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-project-card="${next.id}"] [data-project-card-open]`)?.focus());
  };

  // One bag, built once per render rather than per card: every card reads the same words, and passing
  // the dictionary slice down keeps `ProjectCard` free of a translation context it would otherwise need
  // in every test that mounts a single card.
  const cardLabels: ProjectCardLabels = {
    open: s.openProject,
    openShort: s.cardOpen,
    actions: t.common.actions,
    runtimeManaged: s.runtimeManaged,
    runtimeHost: s.runtimeHost,
    runtimeManagedTitle: s.managed,
    runtimeHostTitle: s.host,
    hostStateTitle: s.hostStateTitle,
    hostStateHint: s.hostStateHint,
    branch: s.branchLabel,
    pathMissing: s.pathMissing,
    team: { strip: s.teamStrip, count: s.membersCount, empty: s.teamEmpty, more: s.teamMore },
    location: {
      host: s.locationHost,
      managed: s.locationManaged,
      hostTitle: s.locationHostTitle,
      guestRoot: s.locationGuestRoot,
      adoptedFrom: s.locationAdoptedFrom,
    },
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
          action: <div className="flex flex-wrap gap-2"><Button onClick={() => defaultProject.mutate()} disabled={defaultProject.isPending || !me.data?.user} title={s.defaultHint}>{s.defaultProject}</Button>{canCreate ? <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button> : null}</div>,
          metrics: <>
            <WorkspaceMetric label={t.projects.metricProjects} value={projects.data?.length ?? 0} icon={FolderGit2} />
            <WorkspaceMetric label={t.projects.metricIcons} value={summary.icons} icon={ImageIcon} />
            <WorkspaceMetric label={t.projects.metricDocumented} value={summary.documented} icon={FileText} />
          </>,
        }}
        // Search-only, and deliberately no `filters`: the register narrows on one text query and
        // nothing else, so an empty Filters trigger would open a panel with nothing in it.
        toolbar={{
          search: (
            <RegisterSearch
              value={query}
              onChange={setQuery}
              placeholder={t.projects.searchPlaceholder}
              label={t.projects.searchLabel}
              onClear={() => setQuery('')}
              clearLabel={t.projects.searchClear}
            />
          ),
        }}
      >
        <ControlSurfaceDocument>
          {projects.isLoading ? <ControlSurfaceState><LoadingState variant="list" /></ControlSurfaceState>
            : projects.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.projects.loadError} onRetry={() => projects.refetch()} /></ControlSurfaceState>
            : !projects.data || projects.data.length === 0 ? <ControlSurfaceState><EmptyState title={t.projects.empty} icon={FolderGit2} action={canCreate ? <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.projects.newProject}</Button> : undefined} /></ControlSurfaceState>
            : (
              <ControlSurfaceRegister className="workspace-master-detail" data-detail={selectedProject != null}>
                <div className="min-w-0">
                  {filteredProjects.length === 0 ? (
                    <ControlSurfaceState><EmptyState title={t.projects.noMatches} icon={Search} /></ControlSurfaceState>
                  ) : (
                    /* The register is a GRID of cards, not a table of rows. A project is an identity, a
                       runtime, a measurement, a repository and a team — five different kinds of fact, of
                       which a table can only align the two that happen to be short. The Path column had
                       already gone for that reason, and the meters had to be drawn twice, once in a
                       wide-only column and once folded into the identity cell, because no single place in
                       a row held them. A card holds all five without competing for one horizontal budget.

                       The column counts are the CONTAINER's, not the viewport's: this same register is
                       rendered inside surfaces of very different widths, and three cards across a phone
                       is the failure the breakpoints exist to prevent. Three is the ceiling deliberately —
                       a fourth column takes a card below the width its exact figures need, and this
                       register is read to find the one project that is misbehaving, not to be filled. */
                    <div
                      role="list"
                      aria-label={t.projects.tableLabel}
                      data-testid="projects-register"
                      className="@container grid grid-cols-1 gap-3 @min-[38rem]:grid-cols-2 @min-[58rem]:grid-cols-3"
                    >
                      {filteredProjects.map((project) => (
                        <ProjectCard
                          key={project.id}
                          project={project}
                          selected={selectedId === project.id}
                          metrics={pluginRows.metricsFor(project.id)}
                          status={pluginRows.statusFor(project.id)}
                          actions={projectActions(project)}
                          members={summariesByProject.get(project.id)?.members}
                          branch={summariesByProject.get(project.id)?.branch}
                          labels={cardLabels}
                          onOpen={() => setSelectedId(project.id)}
                          onContextMenu={(event) => openCtxMenu(event, project)}
                          // Roving arrow/Home/End navigation between cards. It lives on the card because
                          // that is where a keystroke aimed at anything inside it bubbles to; the team
                          // strip consumes the arrows it needs before they get here.
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); navigateProject(project, 'next'); }
                            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); navigateProject(project, 'previous'); }
                            if (event.key === 'Home') { event.preventDefault(); navigateProject(project, 'home'); }
                            if (event.key === 'End') { event.preventDefault(); navigateProject(project, 'end'); }
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* The rail names the record itself. It used to be titled "Project detail" and then
                    repeat the slug and path in a header band of its own directly under that title —
                    two stacked headers for one project. */}
                {selectedProject ? (
                  <WorkspaceDetailRail
                    label={selectedProject.slug}
                    description={selectedProject.executionKind === 'managed' ? s.managed : selectedProject.path}
                    closeLabel={t.common.close}
                    onClose={() => setSelectedId(null)}
                  >
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 py-3">
                      {editorEnabled ? <button type="button" onClick={() => openEditor(null)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-foreground"><Code2 size={13} aria-hidden />{t.projects.openEditor}</button> : null}
                      {canManage(selectedProject) ? <button type="button" onClick={() => openEdit(selectedProject)} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"><Pencil size={13} aria-hidden />{t.projects.editProject}</button> : null}
                      {isAdmin && selectedProject.executionKind !== 'managed' ? <Button variant="ghost" onClick={() => setAdoption({ project: selectedProject, undo: false })}>{s.adoptProject}</Button> : null}
                      {isAdmin && selectedProject.executionKind === 'managed' && selectedProject.adoptedPath && environment.data?.environment.state === 'unprovisioned'
                        ? <Button variant="ghost" onClick={() => setAdoption({ project: selectedProject, undo: true })}>{s.undoAdoption}</Button>
                        : null}
                    </div>

                    <ProjectDetailTabs project={selectedProject} isAdmin={isAdmin} overview={<>
                      {selectedProject.notes ? <p className="border-b border-border/70 py-4 text-xs leading-relaxed text-muted-foreground">{selectedProject.notes}</p> : null}
                      {git.isLoading ? <LoadingLine /> : null}
                      {/* A repository read that could not happen is said out loud, ONCE. A stopped
                          environment is the ordinary case and is not an error: nothing here starts one,
                          and a second generic failure block below would contradict this one. */}
                      {git.isError ? (
                        <p role="alert" className="flex flex-wrap items-center gap-2 py-4 text-xs text-muted-foreground">
                          {git.error instanceof ElowenApiError && git.error.status === 409 ? s.gitEnvironmentStopped : apiErrorMessage(git.error)}
                          <Button variant="ghost" onClick={() => { void git.refetch(); }}>{t.common.retry}</Button>
                        </p>
                      ) : null}
                      {git.data && !git.data.isRepo ? <div className="py-4"><Badge tone="muted">{t.projects.notGit}</Badge></div> : null}
                      {git.data?.status ? (
                        <section className="border-b border-border/70 py-4">
                          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground"><FolderGit2 size={14} className="text-muted-foreground" aria-hidden />{t.projects.git}</h3>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="accent"><GitBranch size={11} className="mr-1" aria-hidden />{git.data.status.branch}</Badge>
                            {git.data.status.clean
                              ? <Badge tone="success"><CheckCircle2 size={11} className="mr-1" aria-hidden />{t.projects.clean}</Badge>
                              : editorEnabled ? <button type="button" onClick={openWorking} title={t.projects.viewChanges} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"><Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge></button>
                              : <Badge tone="warning"><AlertTriangle size={11} className="mr-1" aria-hidden />{t.projects.dirty.replace('{count}', String(git.data.status.dirty))}</Badge>}
                            {git.data.status.ahead > 0 ? <Badge tone="accent"><ArrowUp size={11} className="mr-0.5" aria-hidden />{git.data.status.ahead}</Badge> : null}
                            {git.data.status.behind > 0 ? <Badge tone="muted"><ArrowDown size={11} className="mr-0.5" aria-hidden />{git.data.status.behind}</Badge> : null}
                          </div>
                        </section>
                      ) : null}

                      {git.data?.isRepo && git.data.branches.length > 0 ? (
                        <section className="border-b border-border/70 py-4">
                          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground"><GitBranch size={14} className="text-muted-foreground" aria-hidden />{t.projects.branches}</h3>
                          <div className="flex flex-wrap gap-1.5">{git.data.branches.map((branch) => <Badge key={branch.name} tone={branch.current ? 'accent' : 'muted'}>{branch.name}{branch.current ? ' *' : ''}</Badge>)}</div>
                        </section>
                      ) : null}

                      {git.data?.isRepo && git.data.commits.length > 0 ? (
                        <section className="py-4">
                          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground"><GitCommitHorizontal size={14} className="text-muted-foreground" aria-hidden />{t.projects.commits}</h3>
                          <EntityList>
                            {git.data.commits.map((commit) => (
                              <EntityRow key={commit.hash} interactive={false} className="py-0">
                                {editorEnabled ? <button type="button" onClick={() => openEditor(commit.hash)} title={t.projects.viewCommit} className="flex w-full min-w-0 flex-col gap-1 px-1 py-3 text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70">
                                  <span className="flex min-w-0 items-center gap-2"><span className="font-mono text-[11px] text-primary">{commit.hash}</span><span className="min-w-0 flex-1 truncate text-xs text-foreground">{commit.subject}</span></span>
                                  <span className="text-[10px] text-muted-foreground">{commit.author} · {commit.relative}</span>
                                </button> : <div className="flex min-w-0 flex-col gap-1 px-1 py-3">
                                  <span className="flex min-w-0 items-center gap-2"><span className="font-mono text-[11px] text-primary">{commit.hash}</span><span className="min-w-0 flex-1 truncate text-xs text-foreground">{commit.subject}</span></span>
                                  <span className="text-[10px] text-muted-foreground">{commit.author} · {commit.relative}</span>
                                </div>}
                              </EntityRow>
                            ))}
                          </EntityList>
                        </section>
                      ) : null}
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
            {isAdmin ? <Field label={s.executionKind}><SelectMenu label={s.executionKind} value={executionKind} onChange={(value) => setExecutionKind(value as 'managed' | 'host')} options={[{ value: 'managed', label: s.managed }, { value: 'host', label: s.host }]} /></Field> : null}
            {executionKind === 'managed' ? <p className="text-xs text-muted-foreground">{s.privateHint}</p> : <Field label={t.projects.fieldPath} hint={t.help.projectPath} required>
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t.projects.pathPlaceholder} className="flex-1 font-mono text-xs" {...control} />
                  <Button icon={Folder} variant="default" onClick={() => setBrowseTarget('create')}>{t.projects.browse}</Button>
                </div>
              )}
            </Field>}
            <Field label={t.projects.fieldNotes} hint={t.help.projectNotes}>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none" />
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t.common.cancel}</Button>
            <Button variant="accent" onClick={handleCreate} disabled={createProject.isPending || !canCreate || !slug.trim() || (executionKind === 'host' && (!isAdmin || !path.trim()))}>{t.projects.create}</Button>
          </ModalFooter>
          {browseTarget === 'create' ? (
            <DirectoryPicker
              initialPath={path}
              allowCreateDirectory
              onSelect={(selectedPath) => { setPath(selectedPath); setBrowseTarget(null); }}
              onClose={() => setBrowseTarget(null)}
            />
          ) : null}
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
                    <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                      <ProjectIcon project={live} size={live.icon ? 36 : 22} className="text-muted-foreground" />
                    </span>
                    {/* A managed project picks its icon from its own workspace: the editor's file and raw
                        routes read a managed project through the guest filesystem, and the daemon
                        validates the chosen path inside that same environment before it persists. */}
                    {editorEnabled ? <Button icon={ImageIcon} onClick={() => setIconFor(live)}>{t.projects.chooseIcon}</Button> : null}
                    {live.icon ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={live.icon}>{live.icon}</span> : null}
                  </div>
                );
              })()}
            </Field>
            {editProject.executionKind === 'managed' ? <Badge tone="accent">{s.managed}</Badge> : <Field label={t.projects.fieldPath} hint={t.help.projectPath} required>
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input value={editPath} onChange={(e) => setEditPath(e.target.value)} className="flex-1 font-mono text-xs" {...control} />
                  <Button icon={Folder} variant="default" onClick={() => setBrowseTarget('edit')}>{t.projects.browse}</Button>
                </div>
              )}
            </Field>}
            <Field label={t.projects.fieldNotes} hint={t.help.projectNotes}>
              <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none" />
            </Field>

          </ModalBody>
          <ModalFooter>
            <Button variant="danger" icon={Trash2} onClick={() => setRemoving(editProject)}>{t.projects.removeProject}</Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setEditProject(null)}>{t.common.cancel}</Button>
            <Button variant="accent" onClick={handleUpdate} disabled={updateProject.isPending || !canManage(editProject) || (editProject.executionKind !== 'managed' && !editPath.trim())}>{t.common.save}</Button>
          </ModalFooter>
          {browseTarget === 'edit' ? (
            <DirectoryPicker
              initialPath={editPath}
              onSelect={(selectedPath) => { setEditPath(selectedPath); setBrowseTarget(null); }}
              onClose={() => setBrowseTarget(null)}
            />
          ) : null}
        </Modal>
      )}

      {editorEnabled && iconFor && <ProjectIconPicker project={iconFor} onClose={() => setIconFor(null)} />}

      <ConfirmDialog
        open={adoption !== null}
        title={adoption?.undo ? s.undoAdoption : s.adoptProject}
        description={adoption?.undo ? s.undoAdoptionConfirm : s.adoptConfirm}
        confirmLabel={adoption?.undo ? s.undoAdoption : s.adoptProject}
        confirmVariant="accent"
        pending={adoptProject.isPending}
        onConfirm={handleAdoption}
        onClose={() => { if (!adoptProject.isPending) setAdoption(null); }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={t.projects.removeConfirmTitle}
        description={removing?.executionKind === 'managed' ? s.deleteWarning : removing ? t.projects.removeConfirmBody.replace('{slug}', removing.slug) : undefined}
        confirmLabel={t.projects.removeConfirmBtn}
        onConfirm={handleRemove}
        onClose={() => { if (!removePendingRef.current) setRemoving(null); }}
      />

      <OperationProgressDialog
        open={deletion.open && deletion.pending !== null}
        title={t.operationProgress.actions.delete}
        operation={deletion.operation}
        logTail={deletion.logTail}
        loadError={deletion.loadError}
        onRetry={() => {
          const id = deletion.pending?.projectId;
          if (id === undefined) return;
          void requestEnvironmentAction(id, { kind: 'delete' }, deletion.operation?.generation)
            .then((operation) => deletion.follow(operation.id, id))
            .catch((error) => toast(apiErrorMessage(error), 'error'));
        }}
        onClose={({ running }) => { if (running || deletion.running) deletion.hide(); else deletion.forget(); }}
      />

      <OperationProgressDialog
        open={creationStart.open && creationStart.pending !== null}
        title={t.operationProgress.actions.start}
        operation={creationStart.operation}
        logTail={creationStart.logTail}
        loadError={creationStart.loadError}
        onRetry={() => {
          const id = creationStart.pending?.projectId;
          if (id === undefined) return;
          void requestEnvironmentAction(id, { kind: 'start' }, creationStart.operation?.generation)
            .then((operation) => creationStart.follow(operation.id, id))
            .catch((error) => toast(apiErrorMessage(error), 'error'));
        }}
        onClose={({ running }) => { if (running || creationStart.running) creationStart.hide(); else creationStart.forget(); }}
      />

      {/* The contributing bundles run here, and the dialogs their own actions raise render with them. */}
      {pluginRows.hosts}

      {ctxMenu && <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </>
  );
}
