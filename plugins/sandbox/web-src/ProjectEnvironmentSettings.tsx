import { useEffect, useState } from 'react';
import { acknowledgeEnvironmentRequest, dispatchEnvironmentAction } from './environmentRequest';
import type { EnvironmentAction, EnvironmentOperation, ProjectEnvironment } from '../../../src/plugins/environmentTypes';
import { localizedError, runtime, type Project } from './runtime';

/** The plugin owns this projection; core environment identity and operations remain the shared contract. */
export interface ProjectEnvironmentDetail {
  environment: ProjectEnvironment;
  snapshots: { id: string; generation: number; createdAt: string; consistency: 'crash-consistent'; note: string; completeProject: boolean }[];
  operations: (EnvironmentOperation & { requestId: string })[];
}

type Limits = ProjectEnvironment['limits'];
type LimitKey = 'cpus' | 'memoryMb' | 'pidsLimit';

/** One resource row per ceiling the container actually enforces. The bounds are the plugin's usable
 *  range inside what `environmentRuntime` will accept — it refuses a non-positive CPU figure, a CPU
 *  count above 1024 and any non-integer memory or process value — so a control can never compose a
 *  request the runtime rejects. */
const ROWS: { key: LimitKey; min: number; max: number; step: number }[] = [
  { key: 'cpus', min: 0.1, max: 64, step: 0.1 },
  { key: 'memoryMb', min: 128, max: 65536, step: 128 },
  { key: 'pidsLimit', min: 32, max: 8192, step: 32 },
];
const LIMIT_KEYS = ROWS.map((row) => row.key);
/** CPU carries one decimal; every other figure is a whole number the runtime validates as an integer. */
const readout = (key: LimitKey, value: number) => key === 'cpus' ? String(Math.round(value * 10) / 10) : String(Math.round(value));
const sameLimits = (a: Limits, b: Limits) => LIMIT_KEYS.every((key) => a[key] === b[key]);
/** The daemon names the stale-container case in the error it stores, so the repair is offered from what
 *  the runtime reported rather than inferred from a state word. One rule, read from two places: the
 *  environment's last error and the error of the operation being watched. */
const STALE_CONTAINER = /predates the named project mount/i;

export function ProjectEnvironmentSettings({ project }: { project: Project }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const endpoint = `/plugins/sandbox/api/projects/${project.id}/environment`;
  const queryKey = ['plugin', 'sandbox', 'project-environment', project.id];
  // No refetch interval. The daemon publishes every step of a lifecycle operation on the event bus and
  // the host invalidates this query from it, so the three-second poll that used to keep this screen
  // roughly current is now a request per tick that learns nothing the push has not already delivered.
  const query = hooks.useQuery<ProjectEnvironmentDetail>({ queryKey, queryFn: () => api(endpoint) });
  const me = hooks.useQuery<{ user: { id: number; is_admin: boolean } | null }>({ queryKey: ['me'], queryFn: () => api('/auth/me') });
  const [confirm, setConfirm] = useState<EnvironmentAction | null>(null);
  const [snapshotId, setSnapshotId] = useState('');
  const [requested, setRequested] = useState<EnvironmentOperation | null>(null);
  // The operation the person just started, followed in the shared progress window. Hiding the window
  // leaves it running; the chip beside the controls brings it back.
  const [watched, setWatched] = useState<string | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const progress = hooks.useEnvironmentOperation(watched, project.id);
  const host = hooks.useTranslation();
  const [requestError, setRequestError] = useState('');
  // Local edits only. `null` means "no unsaved change", so a pushed refresh keeps owning the displayed
  // figures and a slider cannot be dragged back by an update landing mid-gesture.
  const [draft, setDraft] = useState<Limits | null>(null);
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
    if (!accountId || !query.data) throw new Error(s.error_project_forbidden);
    const operation = await dispatchEnvironmentAction({ accountId, projectId: project.id, action, generation: query.data.environment.generation, strings: s });
    setRequested(operation);
    return operation;
  };
  const mutate = hooks.useMutation<EnvironmentOperation, unknown, EnvironmentAction>({
    mutationFn: dispatch,
    // Only an explicitly chosen action raises the window. The debounced limits save travels the same
    // dispatch and reports itself through the auto-save indicator it already has; a dialog on every
    // slider release would be a modal interrupting a gesture.
    onSuccess: async (operation: EnvironmentOperation) => { setConfirm(null); setWatched(operation.id); setProgressOpen(true); await refresh(); },
  });
  // A refusal is reported once, where the person is looking: the confirmation renders what its
  // `onConfirm` rejects with, and an action started from a button with no dialog behind it toasts.
  const report = (work: Promise<unknown>) => {
    void work.catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'));
  };

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
  const autoSave = hooks.useAutoSaveStatus([signature], async () => {
    const sent = draft;
    if (!sent) return;
    await dispatch({ kind: 'limits', limits: sent });
    // Clear ONLY the snapshot that actually went out. An edit made while the request was in flight is
    // newer than the answer coming back and must survive it — the hook then saves that one in its turn,
    // and the functional update is what reads the state as it is now rather than as this closure saw it.
    setDraft((current) => (current && sameLimits(current, sent) ? null : current));
    await refresh();
  }, { ready: !!stored, savable: isAdmin && changed, delay: 900 });

  if (query.isError || me.isError) return <C.ErrorState message={localizedError(query.error ?? me.error, s)} onRetry={() => { query.refetch(); me.refetch(); }} />;
  if (query.isLoading || me.isLoading || !query.data) return <C.LoadingState variant="list" />;
  if (!me.data?.user) return <C.ErrorState message={s.error_project_forbidden} />;
  const { environment, snapshots } = query.data;
  const requestedState = requested && (operations.find((item) => item.id === requested.id) ?? requested);
  const operation = operations.find((item) => item.status === 'pending' || item.status === 'running')
    ?? (requestedState && ['pending', 'running'].includes(requestedState.status) ? requestedState : null)
    ?? operations[0] ?? requestedState;
  const pending = running || operation?.status === 'pending' || operation?.status === 'running';
  const busy = !accountId || me.isError || mutate.isPending || pending || ['deleting', 'deleted'].includes(environment.state) || project.lifecycle === 'deleting';
  const completeSnapshots = snapshots.filter((item) => item.completeProject);
  const values = draft ?? environment.limits;
  const labels: Record<LimitKey, string> = { cpus: s.cpuLimit, memoryMb: s.memoryLimit, pidsLimit: s.processLimit };
  const units: Record<LimitKey, string> = { cpus: s.unitCpu, memoryMb: 'MiB', pidsLimit: s.unitProcesses };
  const stale = STALE_CONTAINER.test(environment.lastError ?? '') || STALE_CONTAINER.test(progress.operation?.error ?? '');
  const operationAction = progress.operation?.action.kind ?? 'start';
  // Restoring a snapshot is the one destructive choice this drawer still asks for; stopping and
  // snapshotting are confirmed where they are now offered, in the project's row menu.
  const confirmation = s.restoreWarning;
  const actionLabel = s.restoreEnvironment;
  return <section className="flex flex-col gap-4 border-b border-border py-4">
    <C.Badge tone={environment.state === 'running' ? 'success' : environment.state === 'failed' ? 'danger' : 'muted'}>{s[`state_${environment.state}`]}</C.Badge>
    {requestError ? <p role="alert" className="text-sm text-destructive">{requestError}</p> : null}
    {environment.lastError ? <p role="alert" className="break-words text-sm text-destructive">{environment.lastError}</p> : null}

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
          trailingLayout="stack"
          status={<span className="font-mono text-xs text-foreground">{readout(row.key, values[row.key])} {units[row.key]}</span>}
          control={isAdmin
            ? <C.Slider
              value={values[row.key]}
              min={row.min}
              max={row.max}
              step={row.step}
              disabled={busy}
              aria-label={labels[row.key]}
              onChange={(next: number) => setDraft({ ...values, [row.key]: next })}
            />
            : undefined}
        />
      ))}
    </C.SettingsGroup>

    {/* Start, stop, restart and snapshot are not here any more. They are the project's row actions in the
        register, beside its removal, so every decision about a project is offered where the project is
        listed rather than two screens deeper. What is left below is what only this drawer can do: the
        repair for a container the runtime can no longer verify, and restoring a complete snapshot.
        Deleting the project was never an environment control and lives in that same row menu. */}
    <div className="flex flex-wrap gap-2">
      {stale ? <C.Button disabled={busy} onClick={() => report(mutate.mutateAsync({ kind: 'recreate' }))}>{s.recreateEnvironment}</C.Button> : null}
      {watched && !progressOpen ? (
        <C.Button variant="ghost" onClick={() => setProgressOpen(true)}>{host.t.operationProgress.actions[operationAction] ?? s.startEnvironment}</C.Button>
      ) : null}
    </div>
    <C.Field label={s.snapshots}>
      {completeSnapshots.length ? <div className="flex flex-wrap gap-2"><C.SelectMenu label={s.snapshots} value={snapshotId} onChange={setSnapshotId} options={completeSnapshots.map((item) => ({ value: item.id, label: `${item.createdAt}${item.note ? `: ${item.note}` : ''}` }))} /><C.Button disabled={busy || !completeSnapshots.some((item) => item.id === snapshotId)} onClick={() => setConfirm({ kind: 'restore', snapshotId })}>{s.restoreEnvironment}</C.Button></div> : <p className="text-xs text-muted-foreground">{s.noSnapshots}</p>}
    </C.Field>
    <C.ConfirmDialog open={confirm !== null} title={actionLabel} description={confirmation} confirmLabel={actionLabel} pending={mutate.isPending} onClose={() => setConfirm(null)} onConfirm={async () => { if (confirm) await mutate.mutateAsync(confirm); }} />
    <C.OperationProgressDialog
      open={progressOpen && watched !== null}
      title={host.t.operationProgress.actions[operationAction] ?? s.startEnvironment}
      operation={progress.operation}
      logTail={progress.logTail}
      loadError={progress.loadError}
      onRetry={() => { if (progress.operation) report(mutate.mutateAsync(progress.operation.action as EnvironmentAction)); }}
      onRecreate={() => report(mutate.mutateAsync({ kind: 'recreate' } as EnvironmentAction))}
      recreatable={stale}
      onSettled={() => { setWatched(null); void refresh(); }}
      onClose={({ running }: { running: boolean }) => { setProgressOpen(false); if (!running) setWatched(null); }}
    />
  </section>;
}
