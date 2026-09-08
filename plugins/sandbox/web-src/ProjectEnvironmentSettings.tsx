import { useEffect, useState } from 'react';
import { environmentRequest, acknowledgeEnvironmentRequest } from './environmentRequest';
import type { EnvironmentAction, EnvironmentOperation, ProjectEnvironment } from '../../../src/plugins/environmentTypes';
import { jsonBody, localizedError, runtime, type Project } from './runtime';

/** The plugin owns this projection; core environment identity and operations remain the shared contract. */
export interface ProjectEnvironmentDetail {
  environment: ProjectEnvironment;
  snapshots: { id: string; generation: number; createdAt: string; consistency: 'crash-consistent'; note: string; completeProject: boolean }[];
  operations: (EnvironmentOperation & { requestId: string })[];
  diskBytes?: number;
}

export function ProjectEnvironmentSettings({ project }: { project: Project }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const endpoint = `/plugins/sandbox/api/projects/${project.id}/environment`;
  const queryKey = ['plugin', 'sandbox', 'project-environment', project.id];
  const query = hooks.useQuery<ProjectEnvironmentDetail>({ queryKey, queryFn: () => api(endpoint), refetchInterval: (query: { state: { status: string } }) => query.state.status === 'error' ? false : 3000 });
  const me = hooks.useQuery<{ user: { id: number; is_admin: boolean } | null }>({ queryKey: ['me'], queryFn: () => api('/auth/me') });
  const [confirm, setConfirm] = useState<EnvironmentAction | null>(null);
  const [snapshotId, setSnapshotId] = useState('');
  const [requested, setRequested] = useState<EnvironmentOperation | null>(null);
  const [requestError, setRequestError] = useState('');
  const [limits, setLimits] = useState<ProjectEnvironment['limits'] | null>(null);
  const accountId = me.data?.user?.id;
  useEffect(() => {
    if (!accountId || !query.data) return;
    try {
      acknowledgeEnvironmentRequest(accountId, project.id, query.data.operations.map((operation) => operation.requestId));
      setRequestError('');
    } catch (error) { setRequestError(localizedError(error, s)); }
  }, [accountId, project.id, query.data, s]);
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey }), qc.invalidateQueries({ queryKey: ['projects'] })]); };
  const dispatch = async (action: EnvironmentAction | { kind: 'limits'; limits: ProjectEnvironment['limits'] }): Promise<EnvironmentOperation> => {
    if (!accountId || !query.data) throw new Error('project_forbidden');
    const request = environmentRequest(accountId, project.id, JSON.stringify(action), query.data.environment.generation);
    try {
      const operation = action.kind === 'delete'
        ? (await api(`/projects/${project.id}`, { ...jsonBody(request), method: 'DELETE' }) as { operation: EnvironmentOperation & { requestId: string } }).operation
        : await api(endpoint, jsonBody({ action, ...request })) as EnvironmentOperation & { requestId: string };
      setRequested(operation);
      acknowledgeEnvironmentRequest(accountId, project.id, [operation.requestId]);
      return operation;
    } catch (error) {
      // A definitive validation/access refusal cannot have accepted the intent. Unknown outcomes and
      // conflict responses retain it so a refresh or retry can reconcile with the operation list.
      if (error && typeof error === 'object' && 'status' in error && [400, 401, 403, 404, 422].includes(Number(error.status))) {
        acknowledgeEnvironmentRequest(accountId, project.id, [request.requestId]);
      }
      throw error;
    }
  };
  const mutate = hooks.useMutation<EnvironmentOperation, unknown, EnvironmentAction>({
    mutationFn: dispatch,
    onSuccess: async () => { setConfirm(null); await refresh(); toast(s.operationRequested); },
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });
  const saveLimits = hooks.useMutation<EnvironmentOperation, unknown, ProjectEnvironment['limits']>({
    mutationFn: (value: ProjectEnvironment['limits']) => dispatch({ kind: 'limits', limits: value }),
    onSuccess: async () => { setLimits(null); await refresh(); toast(s.operationRequested); },
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });
  if (query.isError || me.isError) return <C.ErrorState message={localizedError(query.error ?? me.error, s)} onRetry={() => { query.refetch(); me.refetch(); }} />;
  if (query.isLoading || me.isLoading || !query.data) return <C.LoadingState variant="list" />;
  if (!me.data?.user) return <C.ErrorState message={s.error_project_forbidden} />;
  const { environment, snapshots, operations, diskBytes } = query.data;
  const requestedState = requested && (operations.find((item) => item.id === requested.id) ?? requested);
  const operation = operations.find((item) => item.status === 'pending' || item.status === 'running')
    ?? (requestedState && ['pending', 'running'].includes(requestedState.status) ? requestedState : null)
    ?? operations[0] ?? requestedState;
  const pending = operations.some((item) => item.status === 'pending' || item.status === 'running') || operation?.status === 'pending' || operation?.status === 'running';
  const busy = !accountId || me.isError || mutate.isPending || saveLimits.isPending || pending || ['deleting', 'deleted'].includes(environment.state) || project.lifecycle === 'deleting';
  const completeSnapshots = snapshots.filter((item) => item.completeProject);
  const labels = { cpus: s.cpuLimit, memoryMb: s.memoryLimit, pidsLimit: s.processLimit, diskSoftMb: s.diskSoftLimit };
  const confirmation = confirm?.kind === 'restore' ? s.restoreWarning : confirm?.kind === 'delete' ? s.deleteProjectWarning : confirm?.kind === 'snapshot' ? s.snapshotWarning : s.stopWarning;
  const actionLabel = confirm?.kind === 'restore' ? s.restoreEnvironment : confirm?.kind === 'delete' ? s.deleteProject : confirm?.kind === 'snapshot' ? s.snapshotEnvironment : s.stopEnvironment;
  return <section className="flex flex-col gap-4 border-b border-border py-4">
    <div className="flex flex-wrap items-center gap-2"><C.Badge tone={environment.state === 'running' ? 'success' : environment.state === 'failed' ? 'danger' : 'muted'}>{s[`state_${environment.state}`]}</C.Badge><span className="text-xs text-muted-foreground">{s.generation}: {environment.generation}</span></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{s.projectTrust}</p>
    <p className="text-xs leading-relaxed text-muted-foreground">{s.projectCredentials}</p>
    {requestError ? <p role="alert" className="text-sm text-destructive">{requestError}</p> : null}
    {environment.lastError ? <p role="alert" className="break-words text-sm text-destructive">{environment.lastError}</p> : null}
    {operation ? <div role="status" className="text-xs"><span>{s[`operation_${operation.status}`]}</span>{operation.error ? <p className="break-words text-destructive">{operation.error}</p> : null}</div> : null}
    <dl className="grid grid-cols-2 gap-3 text-xs">{(Object.keys(labels) as (keyof typeof labels)[]).map((key) => <div key={key}><dt className="text-muted-foreground">{labels[key]}</dt><dd>{environment.limits[key]}</dd></div>)}</dl>
    <p className="text-xs text-muted-foreground">{s.diskSoftHint}{diskBytes !== undefined ? ` ${s.diskUsage}: ${(diskBytes / 1024 / 1024).toFixed(1)} MiB` : ''}</p>
    {me.data?.user.is_admin ? <C.Button disabled={busy} onClick={() => setLimits({ ...environment.limits })}>{s.editLimits}</C.Button> : null}
    <div className="flex flex-wrap gap-2">
      <C.Button disabled={busy || environment.state === 'running' || environment.state === 'starting'} onClick={() => mutate.mutate({ kind: 'start' })}>{s.startEnvironment}</C.Button>
      <C.Button disabled={busy || environment.state !== 'running'} onClick={() => setConfirm({ kind: 'stop' })}>{s.stopEnvironment}</C.Button>
      <C.Button disabled={busy || !['running', 'stopped'].includes(environment.state)} onClick={() => setConfirm({ kind: 'snapshot' })}>{s.snapshotEnvironment}</C.Button>
      <C.Button variant="danger" disabled={busy} onClick={() => setConfirm({ kind: 'delete' })}>{s.deleteProject}</C.Button>
    </div>
    <C.Field label={s.snapshots}>
      {completeSnapshots.length ? <div className="flex flex-wrap gap-2"><C.SelectMenu label={s.snapshots} value={snapshotId} onChange={setSnapshotId} options={completeSnapshots.map((item) => ({ value: item.id, label: `${item.createdAt}${item.note ? `: ${item.note}` : ''}` }))} /><C.Button disabled={busy || !completeSnapshots.some((item) => item.id === snapshotId)} onClick={() => setConfirm({ kind: 'restore', snapshotId })}>{s.restoreEnvironment}</C.Button></div> : <p className="text-xs text-muted-foreground">{s.noSnapshots}</p>}
    </C.Field>
    <C.ConfirmDialog open={confirm !== null} title={actionLabel} description={confirmation} confirmLabel={actionLabel} pending={mutate.isPending} onClose={() => setConfirm(null)} onConfirm={async () => { if (confirm) { try { await mutate.mutateAsync(confirm); } catch (error) { throw new Error(localizedError(error, s)); } } }} />
    {limits ? <C.Modal title={s.editLimits} onClose={() => { if (!saveLimits.isPending) setLimits(null); }} size="sm"><C.ModalBody>
      {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => <C.Field key={key} label={labels[key]}><C.Input type="number" min={key === 'cpus' ? 0.1 : 1} step={key === 'cpus' ? 0.1 : 1} value={limits[key]} disabled={saveLimits.isPending} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setLimits({ ...limits, [key]: Number(event.target.value) })} /></C.Field>)}
      <p className="text-xs text-muted-foreground">{s.diskSoftHint}</p>
    </C.ModalBody><C.ModalFooter><C.Button disabled={saveLimits.isPending || Object.entries(limits).some(([key, value]) => !Number.isFinite(value) || value <= 0 || (key !== 'cpus' && !Number.isInteger(value)))} onClick={() => saveLimits.mutate(limits)}>{s.saveLimits}</C.Button></C.ModalFooter></C.Modal> : null}
  </section>;
}
