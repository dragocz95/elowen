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

type Limits = ProjectEnvironment['limits'];
type LimitKey = keyof Limits;

/** One resource row. The bounds are the plugin's usable range inside what `environmentRuntime` will
 *  accept — it refuses a non-positive CPU figure, a CPU count above 1024 and any non-integer memory,
 *  process or disk value — so a control can never compose a request the runtime rejects. */
const ROWS: { key: LimitKey; control: 'slider' | 'input'; min: number; max: number; step: number }[] = [
  { key: 'cpus', control: 'slider', min: 0.1, max: 64, step: 0.1 },
  { key: 'memoryMb', control: 'slider', min: 128, max: 65536, step: 128 },
  { key: 'pidsLimit', control: 'slider', min: 32, max: 8192, step: 32 },
  { key: 'diskSoftMb', control: 'input', min: 512, max: 1048576, step: 512 },
];
const LIMIT_KEYS = ROWS.map((row) => row.key);
const DISK_ROW = ROWS.find((row) => row.key === 'diskSoftMb')!;
/** CPU carries one decimal; every other figure is a whole number the runtime validates as an integer. */
const readout = (key: LimitKey, value: number) => key === 'cpus' ? String(Math.round(value * 10) / 10) : String(Math.round(value));
const sameLimits = (a: Limits, b: Limits) => LIMIT_KEYS.every((key) => a[key] === b[key]);

/** Whether a typed figure is one the runtime will actually take for this row: inside the row's range,
 *  and a whole number for everything except the CPU count. `Number('')` is 0 and `Number('abc')` is NaN,
 *  so both the blank box and a half-typed word are rejected here rather than becoming a request. */
const acceptable = (row: typeof ROWS[number], value: number) =>
  Number.isFinite(value) && value >= row.min && value <= row.max && (row.key === 'cpus' || Number.isInteger(value));

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
  // Local edits only. `null` means "no unsaved change", so the 3-second refresh keeps owning the
  // displayed figures and a slider cannot be dragged back by a poll landing mid-gesture.
  const [draft, setDraft] = useState<Limits | null>(null);
  // What is in the disk BOX, which is not the same thing as the disk figure. A person clearing the field
  // to retype it passes through "" and "5" on the way to "51200"; those are an edit in progress, so they
  // stay in the box and never reach the draft. `null` means the box simply shows the current figure.
  const [diskText, setDiskText] = useState<string | null>(null);
  // A saved draft hands the box back to the server's figure.
  useEffect(() => { if (draft === null) setDiskText(null); }, [draft]);
  const accountId = me.data?.user?.id;
  useEffect(() => {
    if (!accountId || !query.data) return;
    try {
      acknowledgeEnvironmentRequest(accountId, project.id, query.data.operations.map((operation) => operation.requestId));
      setRequestError('');
    } catch (error) { setRequestError(localizedError(error, s)); }
  }, [accountId, project.id, query.data, s]);
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey }), qc.invalidateQueries({ queryKey: ['projects'] })]); };
  const dispatch = async (action: EnvironmentAction | { kind: 'limits'; limits: Limits }): Promise<EnvironmentOperation> => {
    if (!accountId || !query.data) throw new Error('project_forbidden');
    const request = environmentRequest(accountId, project.id, JSON.stringify(action), query.data.environment.generation);
    try {
      const operation = await api(endpoint, jsonBody({ action, ...request })) as EnvironmentOperation & { requestId: string };
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

  const stored = query.data?.environment.limits;
  const isAdmin = me.data?.user?.is_admin === true;
  const operations = query.data?.operations ?? [];
  const running = operations.some((item) => item.status === 'pending' || item.status === 'running');
  const changed = !!draft && !!stored && LIMIT_KEYS.some((key) => draft[key] !== stored[key]);
  // The dependency is the CURRENT figures as a stable string, seeded from the server: the hook skips the
  // first value it observes, so watching the draft alone would swallow the very first edit. A poll that
  // moves the server figures also changes it, and `savable` is what keeps that from writing them back.
  const editing = draft ?? stored;
  const signature = editing ? LIMIT_KEYS.map((key) => editing[key]).join('|') : '';
  // Debounced so a drag becomes ONE container update rather than one per step, and so the request the
  // runtime finally sees is the figure the person stopped on.
  // A blank or out-of-range box is not a value yet, so nothing is scheduled while one is on screen.
  const diskEntryValid = diskText === null || (diskText.trim() !== '' && acceptable(DISK_ROW, Number(diskText)));
  const autoSave = hooks.useAutoSaveStatus([signature], async () => {
    const sent = draft;
    if (!sent) return;
    await dispatch({ kind: 'limits', limits: sent });
    // Clear ONLY the snapshot that actually went out. An edit made while the request was in flight is
    // newer than the answer coming back and must survive it — the hook then saves that one in its turn,
    // and the functional update is what reads the state as it is now rather than as this closure saw it.
    setDraft((current) => (current && sameLimits(current, sent) ? null : current));
    await refresh();
  }, { ready: !!stored, savable: isAdmin && changed && diskEntryValid, delay: 900 });

  if (query.isError || me.isError) return <C.ErrorState message={localizedError(query.error ?? me.error, s)} onRetry={() => { query.refetch(); me.refetch(); }} />;
  if (query.isLoading || me.isLoading || !query.data) return <C.LoadingState variant="list" />;
  if (!me.data?.user) return <C.ErrorState message={s.error_project_forbidden} />;
  const { environment, snapshots, diskBytes } = query.data;
  const requestedState = requested && (operations.find((item) => item.id === requested.id) ?? requested);
  const operation = operations.find((item) => item.status === 'pending' || item.status === 'running')
    ?? (requestedState && ['pending', 'running'].includes(requestedState.status) ? requestedState : null)
    ?? operations[0] ?? requestedState;
  const pending = running || operation?.status === 'pending' || operation?.status === 'running';
  const busy = !accountId || me.isError || mutate.isPending || pending || ['deleting', 'deleted'].includes(environment.state) || project.lifecycle === 'deleting';
  const completeSnapshots = snapshots.filter((item) => item.completeProject);
  const values = draft ?? environment.limits;
  const labels: Record<LimitKey, string> = { cpus: s.cpuLimit, memoryMb: s.memoryLimit, pidsLimit: s.processLimit, diskSoftMb: s.diskSoftLimit };
  const units: Record<LimitKey, string> = { cpus: s.unitCpu, memoryMb: 'MiB', pidsLimit: s.unitProcesses, diskSoftMb: 'MiB' };
  const confirmation = confirm?.kind === 'restore' ? s.restoreWarning : confirm?.kind === 'snapshot' ? s.snapshotWarning : s.stopWarning;
  const actionLabel = confirm?.kind === 'restore' ? s.restoreEnvironment : confirm?.kind === 'snapshot' ? s.snapshotEnvironment : s.stopEnvironment;
  return <section className="flex flex-col gap-4 border-b border-border py-4">
    <div className="flex flex-wrap items-center gap-2"><C.Badge tone={environment.state === 'running' ? 'success' : environment.state === 'failed' ? 'danger' : 'muted'}>{s[`state_${environment.state}`]}</C.Badge><span className="text-xs text-muted-foreground">{s.generation}: {environment.generation}</span></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{s.projectTrust}</p>
    <p className="text-xs leading-relaxed text-muted-foreground">{s.projectCredentials}</p>
    {requestError ? <p role="alert" className="text-sm text-destructive">{requestError}</p> : null}
    {environment.lastError ? <p role="alert" className="break-words text-sm text-destructive">{environment.lastError}</p> : null}
    {operation ? <div role="status" className="text-xs"><span>{s[`operation_${operation.status}`]}</span>{operation.error ? <p className="break-words text-destructive">{operation.error}</p> : null}</div> : null}

    <C.SettingsGroup
      title={s.resources}
      description={s.resourcesHint}
      density="compact"
      actions={isAdmin
        ? <C.AutoSaveStatus status={autoSave.status} onRetry={autoSave.retry} />
        : <C.Badge tone="muted">{s.limitsAdminOnly}</C.Badge>}
    >
      {ROWS.map((row) => (
        <C.SettingsRow
          key={row.key}
          label={labels[row.key]}
          description={row.key === 'diskSoftMb' ? s.diskSoftHint : undefined}
          trailingLayout="stack"
          status={<span className="font-mono text-xs text-foreground">{readout(row.key, values[row.key])} {units[row.key]}</span>}
          control={isAdmin
            ? row.control === 'slider'
              ? <C.Slider
                value={values[row.key]}
                min={row.min}
                max={row.max}
                step={row.step}
                disabled={busy}
                aria-label={labels[row.key]}
                onChange={(next: number) => setDraft({ ...values, [row.key]: next })}
              />
              : <div className="flex flex-col gap-1">
                <C.Input
                  type="number"
                  min={row.min}
                  max={row.max}
                  step={row.step}
                  value={diskText ?? values[row.key]}
                  disabled={busy}
                  aria-label={labels[row.key]}
                  aria-invalid={!diskEntryValid || undefined}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    const raw = event.target.value;
                    setDiskText(raw);
                    const parsed = Number(raw);
                    if (raw.trim() !== '' && acceptable(row, parsed)) setDraft({ ...values, [row.key]: parsed });
                  }}
                />
                {diskEntryValid ? null : (
                  <span role="alert" className="text-xs text-destructive">
                    {s.limitsRange.replace('{min}', String(row.min)).replace('{max}', String(row.max)).replace('{unit}', units[row.key])}
                  </span>
                )}
              </div>
            : undefined}
        />
      ))}
      {diskBytes !== undefined
        ? <C.SettingsRow label={s.diskUsage} status={<span className="font-mono text-xs text-foreground">{(diskBytes / 1024 / 1024).toFixed(1)} MiB</span>} />
        : null}
    </C.SettingsGroup>

    <div className="flex flex-wrap gap-2">
      <C.Button disabled={busy || environment.state === 'running' || environment.state === 'starting'} onClick={() => mutate.mutate({ kind: 'start' })}>{s.startEnvironment}</C.Button>
      <C.Button disabled={busy || environment.state !== 'running'} onClick={() => setConfirm({ kind: 'stop' })}>{s.stopEnvironment}</C.Button>
      <C.Button disabled={busy || !['running', 'stopped'].includes(environment.state)} onClick={() => setConfirm({ kind: 'snapshot' })}>{s.snapshotEnvironment}</C.Button>
    </div>
    {/* Deleting the project is not an environment control. It lives in the project's own action menu,
        beside every other project's removal, so the decision is offered in one place whichever way the
        project happens to run. The environment is still torn down with it. */}
    <C.Field label={s.snapshots}>
      {completeSnapshots.length ? <div className="flex flex-wrap gap-2"><C.SelectMenu label={s.snapshots} value={snapshotId} onChange={setSnapshotId} options={completeSnapshots.map((item) => ({ value: item.id, label: `${item.createdAt}${item.note ? `: ${item.note}` : ''}` }))} /><C.Button disabled={busy || !completeSnapshots.some((item) => item.id === snapshotId)} onClick={() => setConfirm({ kind: 'restore', snapshotId })}>{s.restoreEnvironment}</C.Button></div> : <p className="text-xs text-muted-foreground">{s.noSnapshots}</p>}
    </C.Field>
    <C.ConfirmDialog open={confirm !== null} title={actionLabel} description={confirmation} confirmLabel={actionLabel} pending={mutate.isPending} onClose={() => setConfirm(null)} onConfirm={async () => { if (confirm) { try { await mutate.mutateAsync(confirm); } catch (error) { throw new Error(localizedError(error, s)); } } }} />
  </section>;
}
