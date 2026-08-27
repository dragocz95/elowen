import { useMemo, useState } from 'react';
import { GitBranch, Plus, Search, Activity, FileWarning, FolderGit2 } from 'lucide-react';
import { jsonBody, localizedError, runtime, type Overview, type Project, type Workspace } from './runtime';

const QUERY_KEY = ['plugin', 'sandbox', 'overview'];

type CreateForm = { projectId: string; label: string; baseRef: string };
type CommitForm = { message: string; paths: string };
type RemovePreview = {
  workspaceId: string; head: string; dirty: number; untracked: number; uniqueCommits: number;
  activeProcesses: number; files: string[]; previewHash: string; phrase: string;
};

export function WorkspacesSettings({ surface, project }: { surface: 'page' | 'deck' | 'project'; project?: Project }) {
  const { components: C, hooks, api } = runtime();
  const projectMode = surface === 'project' && project !== undefined;
  const s = hooks.usePluginStrings('sandbox');
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const query = hooks.useQuery<Overview>({ queryKey: QUERY_KEY, queryFn: () => api('/plugins/sandbox/api/overview') });
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm | null>(null);
  const [useWorkspace, setUseWorkspace] = useState<Workspace | null>(null);
  const [useSession, setUseSession] = useState('');
  const [commitWorkspace, setCommitWorkspace] = useState<Workspace | null>(null);
  const [commitForm, setCommitForm] = useState<CommitForm>({ message: '', paths: '' });
  const [removeWorkspace, setRemoveWorkspace] = useState<Workspace | null>(null);
  const [removePreview, setRemovePreview] = useState<RemovePreview | null>(null);
  const [removePhrase, setRemovePhrase] = useState('');

  const invalidate = async () => { await qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'overview'] }); };
  const useSandboxMutation = <TVars, TData = unknown>(path: string, success: string) => hooks.useMutation<TData, unknown, TVars>({
    mutationFn: (value: TVars) => api(path, jsonBody(value)),
    onSuccess: async () => { await invalidate(); toast(success); },
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });
  const create = useSandboxMutation<CreateForm>('/plugins/sandbox/api/workspaces/create', s.created);
  const activate = useSandboxMutation<{ workspaceId: string; sessionId: string }>('/plugins/sandbox/api/workspaces/use', s.activated);
  const commit = useSandboxMutation<{ workspaceId: string; message: string; paths: string[] }>('/plugins/sandbox/api/workspaces/commit', s.committed);
  const remove = useSandboxMutation<Record<string, unknown>>('/plugins/sandbox/api/workspaces/remove', s.removed);
  const preview = hooks.useMutation<RemovePreview, unknown, { workspaceId: string }>({
    mutationFn: (value: { workspaceId: string }) => api('/plugins/sandbox/api/workspaces/remove-preview', jsonBody(value)) as Promise<RemovePreview>,
    onSuccess: (data: RemovePreview) => setRemovePreview(data),
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });

  const data = query.data;
  const projects = useMemo(() => data?.projects ?? [], [data?.projects]);
  const workspaces = useMemo(() => data?.workspaces ?? [], [data?.workspaces]);
  const projectNames = useMemo(() => new Map(projects.map((item) => [item.id, item.slug])), [projects]);
  const effectiveProjectFilter = projectMode ? String(project?.id ?? '') : projectFilter;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return workspaces.filter((workspace) => {
      if (effectiveProjectFilter !== 'all' && workspace.projectId !== Number(effectiveProjectFilter)) return false;
      if (!needle) return true;
      return [workspace.label, workspace.branch, workspace.baseRef, projectNames.get(workspace.projectId) ?? '']
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [workspaces, search, effectiveProjectFilter, projectNames]);
  const selected = filtered.find((workspace) => workspace.id === selectedId) ?? null;
  const counted = projectMode ? filtered : workspaces;
  const activeCount = counted.filter((workspace) => workspace.bindings.length > 0).length;
  const changedCount = counted.reduce((sum, workspace) => sum + (workspace.status?.dirty ?? 0) + (workspace.status?.untracked ?? 0), 0);

  const diff = hooks.useQuery<{ diff: string }>({
    queryKey: ['plugin', 'sandbox', 'diff', selected?.id],
    queryFn: () => api('/plugins/sandbox/api/workspaces/diff', jsonBody({ workspaceId: selected?.id })),
    enabled: !!selected,
  });

  const stateBadges = (workspace: Workspace) => {
    const status = workspace.status;
    return (
      <div className="flex flex-wrap gap-1.5">
        {workspace.bindings.length > 0 ? <C.Badge tone="accent">{s.active}</C.Badge> : null}
        {workspace.lifecycle === 'orphaned' || !workspace.accessible ? <C.Badge tone="danger">{s.orphaned}</C.Badge> : null}
        {status?.clean ? <C.Badge tone="success">{s.clean}</C.Badge> : null}
        {(status?.dirty ?? 0) > 0 ? <C.Badge tone="warning">{s.dirty}: {status?.dirty}</C.Badge> : null}
        {(status?.untracked ?? 0) > 0 ? <C.Badge tone="warning">{s.untracked}: {status?.untracked}</C.Badge> : null}
      </div>
    );
  };

  const openRemove = (workspace: Workspace) => {
    setRemoveWorkspace(workspace);
    setRemovePreview(null);
    setRemovePhrase('');
    preview.mutate({ workspaceId: workspace.id });
  };

  const submitRemove = () => {
    if (!removeWorkspace || !removePreview) return;
    const dirty = removePreview.dirty > 0 || removePreview.untracked > 0 || removePreview.uniqueCommits > 0;
    remove.mutate({
      workspaceId: removeWorkspace.id,
      ...(dirty ? { discard: true, previewHash: removePreview.previewHash, phrase: removePhrase } : {}),
    }, { onSuccess: () => { setRemoveWorkspace(null); setRemovePreview(null); setSelectedId(null); } });
  };

  const selectedDetail = selected ? (
    <div className="flex flex-col gap-5 p-4">
      <div>
        <p className="font-mono text-xs text-text">{selected.branch}</p>
        <p className="mt-1 break-all font-mono text-[11px] text-text-muted">{selected.path}</p>
      </div>
      {stateBadges(selected)}
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-text-muted">{s.ahead}</dt><dd className="font-mono text-text">{selected.status?.ahead ?? 0}</dd></div>
        <div><dt className="text-text-muted">{s.behind}</dt><dd className="font-mono text-text">{selected.status?.behind ?? 0}</dd></div>
        <div><dt className="text-text-muted">{s.processes}</dt><dd className="font-mono text-text">{selected.activeProcesses}</dd></div>
        <div><dt className="text-text-muted">{s.lastUsed}</dt><dd className="text-text">{new Date(selected.lastUsedAt).toLocaleString()}</dd></div>
      </dl>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{s.changedFiles}</h3>
        {selected.files.length ? <ul className="space-y-1 font-mono text-xs text-text">{selected.files.map((file) => <li key={`${file.code}:${file.path}`}>{file.code} {file.path}</li>)}</ul> : <p className="text-xs text-text-muted">{s.clean}</p>}
      </div>
      <div className="min-h-52 overflow-hidden rounded-lg border border-border">
        <C.PatchView diff={diff.data?.diff ?? ''} empty={s.emptyPatch} loading={diff.isLoading} />
      </div>
      <div className="flex flex-wrap gap-2">
        <C.Button onClick={() => { setUseWorkspace(selected); setUseSession(data?.sessions[0]?.id ?? ''); }} disabled={!selected.accessible || selected.lifecycle !== 'active'}>{s.use}</C.Button>
        <C.Button onClick={() => { setCommitWorkspace(selected); setCommitForm({ message: '', paths: selected.files.map((file) => file.path).join('\n') }); }} disabled={!selected.accessible || selected.lifecycle !== 'active' || selected.files.length === 0}>{s.commit}</C.Button>
        <C.Button variant="danger" onClick={() => openRemove(selected)} disabled={!selected.accessible}>{s.remove}</C.Button>
      </div>
    </div>
  ) : null;

  const content = query.isError ? (
    <C.ErrorState message={s.loadError} onRetry={() => query.refetch()} />
  ) : query.isLoading ? (
    <C.LoadingState variant="list" />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
      {projectMode ? (
        <div className="flex justify-end">
          <C.Button variant="accent" icon={Plus} onClick={() => setCreateForm({ projectId: String(project?.id ?? ''), label: '', baseRef: 'main' })}>{s.create}</C.Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative min-w-0 flex-1">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <C.Input value={search} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)} placeholder={s.search} className="pl-9" />
          </div>
          <C.SelectMenu
            value={projectFilter}
            onChange={setProjectFilter}
            label={s.project}
            options={[{ value: 'all', label: s.filterAll }, ...projects.map((item) => ({ value: String(item.id), label: item.slug }))]}
          />
          <C.Button variant="accent" icon={Plus} onClick={() => setCreateForm({ projectId: String(projects[0]?.id ?? ''), label: '', baseRef: 'main' })} disabled={projects.length === 0}>{s.create}</C.Button>
        </div>
      )}

      {filtered.length === 0 ? <C.EmptyState title={s.emptyWorkspaces} icon={FolderGit2} /> : (
        <C.DataTable ariaLabel={s.tableLabel} columns="minmax(14rem,1.2fr) minmax(9rem,.7fr) minmax(14rem,1fr) minmax(13rem,1fr) 1.25rem" compactColumns="minmax(0,1fr) 1.25rem">
          <C.DataTableRow header>
            <C.DataTableCell header>{s.columnWorkspace}</C.DataTableCell>
            <C.DataTableCell header priority="wide">{s.columnProject}</C.DataTableCell>
            <C.DataTableCell header priority="wide">{s.columnBranch}</C.DataTableCell>
            <C.DataTableCell header priority="wide">{s.columnState}</C.DataTableCell>
            {/* The chevron track carries no header: its cell is decorative. */}
          </C.DataTableRow>
          {filtered.map((workspace) => {
            const projectName = projectNames.get(workspace.projectId) ?? `#${workspace.projectId}`;
            return (
              // The label cell stacks the base ref under the label (and the state badges under both on a
              // narrow surface), so the row asks for the two-line rhythm rather than deforming the
              // one-line one.
              <C.DataTableRow
                key={workspace.id}
                height="tall"
                selected={workspace.id === selectedId}
                aria-selected={workspace.id === selectedId}
                onOpen={() => setSelectedId(workspace.id)}
                openLabel={s.openWorkspace.replace('{name}', workspace.label)}
              >
                <C.DataTableCell lines="auto" title={workspace.label}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text">{workspace.label}</div>
                    <div className="truncate font-mono text-[11px] text-text-muted">{workspace.baseRef}</div>
                    <div className="mt-2 sm:hidden">{stateBadges(workspace)}</div>
                  </div>
                </C.DataTableCell>
                <C.DataTableCell priority="wide" title={projectName} className="text-xs text-text-muted">{projectName}</C.DataTableCell>
                <C.DataTableCell priority="wide" title={workspace.branch} className="font-mono text-xs text-text-muted">{workspace.branch}</C.DataTableCell>
                <C.DataTableCell priority="wide" lines="auto">{stateBadges(workspace)}</C.DataTableCell>
                <C.DataTableChevronCell />
              </C.DataTableRow>
            );
          })}
        </C.DataTable>
      )}

      {selected && !projectMode ? (
        <C.WorkspaceDetailRail label={selected.label} closeLabel={s.cancel} onClose={() => setSelectedId(null)}>
          {selectedDetail}
        </C.WorkspaceDetailRail>
      ) : null}
    </div>
  );

  const framed = surface !== 'page' ? content : (
    <C.SpatialWorkspaceLayout hero={{
      eyebrow: s.workspacesTitle,
      title: s.workspacesTitle,
      count: workspaces.length,
      description: s.workspacesHint,
      mascotState: query.isError ? 'error' : query.isLoading ? 'saving' : 'idle',
      metrics: <>
        <C.WorkspaceMetric label={s.workspaceCount} value={workspaces.length} icon={GitBranch} />
        <C.WorkspaceMetric label={s.activeCount} value={activeCount} icon={Activity} />
        <C.WorkspaceMetric label={s.changedCount} value={changedCount} icon={FileWarning} />
      </>,
    }}>{content}</C.SpatialWorkspaceLayout>
  );

  return <>
    {framed}
    {selected && projectMode ? (
      <C.Modal title={selected.label} size="lg" onClose={() => setSelectedId(null)}>
        <C.ModalBody>{selectedDetail}</C.ModalBody>
      </C.Modal>
    ) : null}
    {createForm ? (
      <C.Modal title={s.createTitle} size="sm" onClose={() => setCreateForm(null)}>
        <C.ModalBody>
          {!projectMode ? <C.Field label={s.project}><C.SelectMenu value={createForm.projectId} onChange={(projectId: string) => setCreateForm({ ...createForm, projectId })} label={s.project} options={projects.map((item) => ({ value: String(item.id), label: item.slug }))} /></C.Field> : null}
          <C.Field label={s.label}><C.Input autoFocus value={createForm.label} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCreateForm({ ...createForm, label: event.target.value })} placeholder={s.labelPlaceholder} /></C.Field>
          <C.Field label={s.baseRef}><C.Input value={createForm.baseRef} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCreateForm({ ...createForm, baseRef: event.target.value })} placeholder={s.baseRefPlaceholder} className="font-mono" /></C.Field>
        </C.ModalBody>
        <C.ModalFooter><C.Button variant="ghost" onClick={() => setCreateForm(null)}>{s.cancel}</C.Button><C.Button variant="accent" onClick={() => create.mutate(createForm, { onSuccess: () => setCreateForm(null) })} disabled={create.isPending || !createForm.projectId || !createForm.label.trim() || !createForm.baseRef.trim()}>{s.save}</C.Button></C.ModalFooter>
      </C.Modal>
    ) : null}
    {useWorkspace ? (
      <C.Modal title={s.useTitle} size="sm" onClose={() => setUseWorkspace(null)}>
        <C.ModalBody><C.Field label={s.conversation}><C.SelectMenu value={useSession} onChange={setUseSession} label={s.conversation} options={(data?.sessions ?? []).map((session) => ({ value: session.id, label: session.title }))} /></C.Field></C.ModalBody>
        <C.ModalFooter><C.Button variant="ghost" onClick={() => setUseWorkspace(null)}>{s.cancel}</C.Button><C.Button variant="accent" disabled={!useSession || activate.isPending} onClick={() => activate.mutate({ workspaceId: useWorkspace.id, sessionId: useSession }, { onSuccess: () => setUseWorkspace(null) })}>{s.use}</C.Button></C.ModalFooter>
      </C.Modal>
    ) : null}
    {commitWorkspace ? (
      <C.Modal title={s.commitTitle} size="md" onClose={() => setCommitWorkspace(null)}>
        <C.ModalBody>
          <C.Field label={s.commitMessage}><C.Input autoFocus value={commitForm.message} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCommitForm({ ...commitForm, message: event.target.value })} /></C.Field>
          <C.Field label={s.commitPaths} hint={s.commitPathsHint}><textarea className="min-h-40 w-full rounded-md border border-border bg-bg p-3 font-mono text-xs text-text" value={commitForm.paths} onChange={(event) => setCommitForm({ ...commitForm, paths: event.target.value })} /></C.Field>
        </C.ModalBody>
        <C.ModalFooter><C.Button variant="ghost" onClick={() => setCommitWorkspace(null)}>{s.cancel}</C.Button><C.Button variant="accent" disabled={commit.isPending || !commitForm.message.trim() || !commitForm.paths.trim()} onClick={() => commit.mutate({ workspaceId: commitWorkspace.id, message: commitForm.message, paths: commitForm.paths.split('\n').map((path) => path.trim()).filter(Boolean) }, { onSuccess: () => setCommitWorkspace(null) })}>{s.commit}</C.Button></C.ModalFooter>
      </C.Modal>
    ) : null}
    {removeWorkspace && removePreview ? (() => {
      const destructive = removePreview.dirty > 0 || removePreview.untracked > 0 || removePreview.uniqueCommits > 0;
      if (!destructive) return <C.ConfirmDialog open title={s.removeTitle} description={`${s.removeCleanDescription}\n${s.processes}: ${removePreview.activeProcesses}`} confirmLabel={s.remove} onClose={() => setRemoveWorkspace(null)} onConfirm={submitRemove} />;
      return (
        <C.Modal title={s.discardTitle} size="md" onClose={() => setRemoveWorkspace(null)}>
          <C.ModalBody>
            <p className="text-sm leading-relaxed text-danger">{s.discardWarning}</p>
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 font-mono text-xs text-text">
              <div>{s.dirty}: {removePreview.dirty}</div><div>{s.untracked}: {removePreview.untracked}</div><div>{s.ahead}: {removePreview.uniqueCommits}</div><div>{s.processes}: {removePreview.activeProcesses}</div>
              {removePreview.files.map((file) => <div key={file}>{file}</div>)}
            </div>
            <C.Field label={`${s.confirmationPhrase}: ${removePreview.phrase}`}><C.Input autoFocus value={removePhrase} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRemovePhrase(event.target.value)} /></C.Field>
          </C.ModalBody>
          <C.ModalFooter><C.Button variant="ghost" onClick={() => setRemoveWorkspace(null)}>{s.cancel}</C.Button><C.Button variant="danger" disabled={removePhrase !== removePreview.phrase || remove.isPending || removePreview.activeProcesses > 0} onClick={submitRemove}>{s.remove}</C.Button></C.ModalFooter>
        </C.Modal>
      );
    })() : null}
  </>;
}
