import { useEffect, useRef, useState } from 'react';
import { CircleDashed, CircleSlash, Loader2, Plus, Play, Square, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { acknowledgeEnvironmentRequest, dispatchEnvironmentAction } from './environmentRequest';
import type { EnvironmentAction, EnvironmentOperation, ProjectEnvironment } from '../../../src/plugins/environmentTypes';
import { localizedError, runtime, type Project } from './runtime';

/** The plugin owns this projection; core environment identity and operations remain the shared contract. */
export interface EnvironmentRuntimeReadiness {
  ready: boolean;
  items: { id: string; label: string; ok: boolean; detail?: string }[];
}

export interface ProjectEnvironmentDetail {
  environment: ProjectEnvironment;
  /** Which runtime this environment runs on, and while that is still open, what the host is missing.
   *  `name` is null when the host cannot hold an environment at all, which is when `readiness` says why. */
  runtime: { name: 'nspawn' | null; pending: boolean; readiness: EnvironmentRuntimeReadiness | null };
  snapshots: { id: string; generation: number; createdAt: string; consistency: 'crash-consistent'; note: string; completeProject: boolean }[];
  operations: (EnvironmentOperation & { requestId: string })[];
}

type Limits = ProjectEnvironment['limits'];
type NetworkPolicy = ProjectEnvironment['network'];
type InboundPort = NetworkPolicy['inboundPorts'][number];
type PortDraft = { protocol: InboundPort['protocol']; hostPort: string; guestPort: string };
type NetworkDraft = { mode: NetworkPolicy['mode']; inboundPorts: PortDraft[] };
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
const sameNetwork = (a: NetworkPolicy, b: NetworkPolicy) => JSON.stringify(a) === JSON.stringify(b);
const toNetworkDraft = (network: NetworkPolicy): NetworkDraft => ({
  mode: network.mode,
  inboundPorts: network.inboundPorts.map((port) => ({ protocol: port.protocol, hostPort: String(port.hostPort), guestPort: String(port.guestPort) })),
});
const emptyPortDraft = (): PortDraft => ({ protocol: 'tcp', hostPort: '8080', guestPort: '3000' });
const parsePort = (port: PortDraft): InboundPort | null => {
  if (!/^\d+$/.test(port.hostPort) || !/^\d+$/.test(port.guestPort)) return null;
  const hostPort = Number(port.hostPort);
  const guestPort = Number(port.guestPort);
  if (!Number.isSafeInteger(hostPort) || hostPort < 1024 || hostPort > 65535) return null;
  if (!Number.isSafeInteger(guestPort) || guestPort < 1 || guestPort > 65535) return null;
  return { protocol: port.protocol, hostPort, guestPort };
};
const toNetworkPolicy = (draft: NetworkDraft): NetworkPolicy | null => {
  if (draft.mode === 'isolated') return draft.inboundPorts.length ? null : { mode: 'isolated', inboundPorts: [] };
  const inboundPorts = draft.inboundPorts.map(parsePort);
  return inboundPorts.every((port): port is InboundPort => port !== null) ? { mode: 'shared', inboundPorts } : null;
};

/** The same glyph and tone the project register draws for a state, so the drawer and the row agree. */
const STATE_GLYPH: Record<ProjectEnvironment['state'], { icon: LucideIcon; className: string; spin?: boolean }> = {
  running: { icon: Play, className: 'text-success' },
  starting: { icon: Loader2, className: 'text-accent', spin: true },
  stopped: { icon: Square, className: 'text-muted-foreground' },
  unprovisioned: { icon: CircleDashed, className: 'text-muted-foreground' },
  failed: { icon: TriangleAlert, className: 'text-destructive' },
  deleting: { icon: Loader2, className: 'text-warning', spin: true },
  deleted: { icon: CircleSlash, className: 'text-muted-foreground' },
};

export function ProjectEnvironmentSettings({ project }: { project: Project }) {
  const { components: C, hooks, utils, api } = runtime();
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
  const [draft, setDraft] = useState<Limits | null>(null);
  const [networkDraft, setNetworkDraft] = useState<NetworkDraft | null>(null);
  const accountId = me.data?.user?.id;
  const isAdmin = me.data?.user?.is_admin === true;
  const stored = query.data?.environment.limits;
  const storedNetwork = query.data?.environment.network;
  const draftRef = useRef<Limits | null>(null);
  const networkDraftRef = useRef<NetworkDraft | null>(null);
  const confirmedLimitsRef = useRef<Limits | null>(null);
  const confirmedNetworkRef = useRef<NetworkPolicy | null>(null);
  const generationRef = useRef<number | null>(null);
  draftRef.current = draft;
  networkDraftRef.current = networkDraft;

  useEffect(() => {
    if (!accountId || !query.data) return;
    try {
      acknowledgeEnvironmentRequest(accountId, project.id, query.data.operations.map((operation) => operation.requestId));
      setRequestError('');
    } catch (error) { setRequestError(localizedError(error, s)); }
  }, [accountId, project.id, query.data, s]);
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey }), qc.invalidateQueries({ queryKey: ['projects'] })]); };
  const dispatch = async (action: EnvironmentAction): Promise<EnvironmentOperation> => {
    const generation = generationRef.current ?? query.data?.environment.generation;
    if (!accountId || !query.data || generation === undefined || generation === null) throw new Error(s.error_project_forbidden);
    const operation = await dispatchEnvironmentAction({ accountId, projectId: project.id, action, generation, strings: s });
    setRequested(operation);
    return operation;
  };
  const waitForOperation = async (operation: EnvironmentOperation): Promise<EnvironmentOperation> => {
    if (operation.status === 'succeeded' || operation.status === 'failed') return operation;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const next = await api(`/plugins/sandbox/api/environments/operation?operationId=${encodeURIComponent(operation.id)}&projectId=${project.id}`) as EnvironmentOperation | null;
      if (!next) throw new Error(s.errorFallback);
      if (next.status === 'succeeded' || next.status === 'failed') return next;
    }
    throw new Error(s.errorFallback);
  };
  const mutate = hooks.useMutation<EnvironmentOperation, unknown, EnvironmentAction>({
    mutationFn: dispatch,
    onSuccess: async (operation: EnvironmentOperation) => { setConfirm(null); setWatched(operation.id); setProgressOpen(true); await refresh(); },
  });
  const report = (work: Promise<unknown>) => {
    void work.catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'));
  };

  useEffect(() => {
    if (!query.data) return;
    generationRef.current = query.data.environment.generation;
    if (!confirmedLimitsRef.current) confirmedLimitsRef.current = query.data.environment.limits;
    if (!confirmedNetworkRef.current) confirmedNetworkRef.current = query.data.environment.network;
  }, [query.data]);
  useEffect(() => {
    if (!stored || !storedNetwork) return;
    if (!draft) confirmedLimitsRef.current = stored;
    else if (sameLimits(draft, stored)) { confirmedLimitsRef.current = stored; setDraft(null); }
    if (!networkDraft) confirmedNetworkRef.current = storedNetwork;
    else {
      const current = toNetworkPolicy(networkDraft);
      if (current && sameNetwork(current, storedNetwork)) { confirmedNetworkRef.current = storedNetwork; setNetworkDraft(null); }
    }
  }, [stored, storedNetwork, draft, networkDraft]);

  const limitsChanged = !!draft && !!(confirmedLimitsRef.current ?? stored) && !sameLimits(draft, confirmedLimitsRef.current ?? stored!);
  const networkAction = networkDraft ? toNetworkPolicy(networkDraft) : null;
  const networkChanged = !!networkAction && !!(confirmedNetworkRef.current ?? storedNetwork) && !sameNetwork(networkAction, confirmedNetworkRef.current ?? storedNetwork!);
  const saveOrdinarySettings = async () => {
    const limits = draftRef.current;
    const confirmedLimits = confirmedLimitsRef.current ?? stored;
    const currentNetwork = networkDraftRef.current ? toNetworkPolicy(networkDraftRef.current) : null;
    const confirmedNetwork = confirmedNetworkRef.current ?? storedNetwork;
    const action: EnvironmentAction | null = limits && confirmedLimits && !sameLimits(limits, confirmedLimits)
      ? { kind: 'limits', limits: { cpus: limits.cpus, memoryMb: limits.memoryMb, pidsLimit: limits.pidsLimit } }
      : currentNetwork && confirmedNetwork && !sameNetwork(currentNetwork, confirmedNetwork)
        ? { kind: 'network', network: currentNetwork }
        : null;
    if (!action) return;
    const operation = await dispatch(action);
    const settled = await waitForOperation(operation);
    if (settled.status === 'failed') throw new Error(settled.error || s.errorFallback);
    if (action.kind === 'limits') confirmedLimitsRef.current = action.limits;
    else confirmedNetworkRef.current = action.network;
    await refresh();
  };
  const autosaveSignature = `${draft ? LIMIT_KEYS.map((key) => draft[key]).join('|') : stored ? LIMIT_KEYS.map((key) => stored[key]).join('|') : ''}|${JSON.stringify(networkDraft ?? storedNetwork ?? null)}`;
  const autoSave = hooks.useAutoSaveStatus([autosaveSignature], saveOrdinarySettings, {
    ready: !!stored && !!storedNetwork,
    savable: isAdmin && (limitsChanged || networkChanged),
    delay: 700,
  });
  const operations = query.data?.operations ?? [];
  const running = operations.some((item) => item.status === 'pending' || item.status === 'running');

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
  const networkValues = networkDraft ?? toNetworkDraft(environment.network);
  const labels: Record<LimitKey, string> = { cpus: s.cpuLimit, memoryMb: s.memoryLimit, pidsLimit: s.processLimit };
  const units: Record<LimitKey, string> = { cpus: s.unitCpu, memoryMb: 'MiB', pidsLimit: s.unitProcesses };
  // The daemon names the stale-container case in the error it stores, so the repair is offered from what
  // the runtime reported rather than inferred from a state word: the environment's last error and the
  // error of the operation being watched are read through the host's own rule for it.
  const stale = utils.recreatable(environment.lastError) || utils.recreatable(progress.operation?.error);
  const operationAction = progress.operation?.action.kind ?? 'start';
  // Restoring a snapshot is the one destructive choice this drawer still asks for; stopping and
  // snapshotting are confirmed where they are now offered, in the project's row menu.
  const confirmation = s.restoreWarning;
  const actionLabel = s.restoreEnvironment;
  // An overview written before this field still parses; it simply has no runtime to report.
  const runtimeDetail = query.data.runtime ?? { name: null, pending: false, readiness: null };
  const glyph = STATE_GLYPH[environment.state] ?? STATE_GLYPH.unprovisioned;
  const StateIcon = glyph.icon;
  const stateLabel = s[`state_${environment.state}`] || environment.state;
  // The state reads as the same glyph the project register uses, rather than as a banner above the table.
  const state = <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-label={stateLabel}>
    <StateIcon aria-hidden className={`h-3.5 w-3.5 ${glyph.className}${glyph.spin ? ' animate-spin' : ''}`} />
    {stateLabel}
    {runtimeDetail.name ? <C.Badge tone="muted">{runtimeDetail.name === 'nspawn' ? s.runtimeMachine : s.runtimeContainer}</C.Badge> : null}
  </span>;
  // Every row the host has not satisfied, with the command the helper itself names. The ids are the
  // helper's and have already moved once, so nothing here is keyed off them: a row is drawn because it
  // is unmet, and its label and detail are what it says about itself.
  const unmet = runtimeDetail.readiness && !runtimeDetail.readiness.ready
    ? runtimeDetail.readiness.items.filter((item) => !item.ok)
    : [];
  const setNetworkMode = (mode: NetworkPolicy['mode']) => setNetworkDraft({ mode, inboundPorts: mode === 'isolated' ? [] : networkValues.inboundPorts });
  const updatePort = (index: number, patch: Partial<PortDraft>) => setNetworkDraft({ ...networkValues,
    inboundPorts: networkValues.inboundPorts.map((port, position) => position === index ? { ...port, ...patch } : port) });
  const removePort = (index: number) => setNetworkDraft({ ...networkValues, inboundPorts: networkValues.inboundPorts.filter((_port, position) => position !== index) });
  const flushAutosave = () => { void autoSave.flush(); };

  return <section className="flex flex-col gap-4 border-b border-border py-4">
    {requestError ? <p role="alert" className="text-sm text-destructive">{requestError}</p> : null}
    {unmet.length ? <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-sm font-medium text-destructive">{s.runtimeNotReady}</p>
      <ul className="flex flex-col gap-1.5">
        {unmet.map((item) => <li key={item.id} className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{item.label}</span>
          {item.detail ? <span className="break-words"> — {item.detail}</span> : null}
        </li>)}
      </ul>
    </div> : null}
    {environment.lastError ? <p role="alert" className="break-words text-sm text-destructive">{environment.lastError}</p> : null}

    <C.SettingsGroup
      title={s.resources}
      hint={s.resourcesHint}
      density="compact"
      actions={<span className="inline-flex min-w-0 shrink-0 items-center gap-3 whitespace-nowrap">
        {state}
        {isAdmin ? null : <C.Badge tone="muted">{s.limitsAdminOnly}</C.Badge>}
      </span>}
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

    <C.SettingsGroup
      title={s.networking}
      hint={s.networkingHint}
      density="compact"
      actions={isAdmin
        ? <span className="inline-flex min-h-5 min-w-[7rem] shrink-0 items-center justify-end whitespace-nowrap"><C.AutoSaveStatus status={autoSave.status} onRetry={autoSave.retry} showSaved /></span>
        : <C.Badge tone="muted">{s.limitsAdminOnly}</C.Badge>}
    >
      <C.SettingsRow label={s.networkMode} hint={networkValues.mode === 'shared' ? s.networkSharedHint : s.networkIsolatedHint}
        control={<C.SelectMenu label={s.networkMode} value={networkValues.mode} disabled={!isAdmin || busy}
          onChange={setNetworkMode} options={[{ value: 'shared', label: s.networkShared }, { value: 'isolated', label: s.networkIsolated }]} />} />
      {networkValues.mode === 'shared' ? <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="text-sm font-medium text-foreground">{s.inboundPorts}</p>
            <C.HelpTip align="left">{s.inboundPortsHint}</C.HelpTip>
          </div>
          {isAdmin ? <C.Button variant="ghost" icon={Plus} disabled={busy || networkValues.inboundPorts.length >= 32}
            onClick={() => setNetworkDraft({ ...networkValues, inboundPorts: [...networkValues.inboundPorts, emptyPortDraft()] })}>{s.addInboundPort}</C.Button> : null}
        </div>
        {networkValues.inboundPorts.length ? <div className="flex flex-col gap-2">
          {networkValues.inboundPorts.map((port, index) => <div key={index} className="grid grid-cols-1 items-end gap-2 rounded-md border border-border bg-background p-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <C.SelectMenu label={s.protocol} value={port.protocol} disabled={!isAdmin || busy} onChange={(protocol: InboundPort['protocol']) => updatePort(index, { protocol })}
              options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]} />
            <C.Field label={s.hostPort}><C.Input type="number" min={1024} max={65535} value={port.hostPort} disabled={!isAdmin || busy}
              onChange={(event: { target: { value: string } }) => updatePort(index, { hostPort: event.target.value })} onBlur={flushAutosave} /></C.Field>
            <C.Field label={s.guestPort}><C.Input type="number" min={1} max={65535} value={port.guestPort} disabled={!isAdmin || busy}
              onChange={(event: { target: { value: string } }) => updatePort(index, { guestPort: event.target.value })} onBlur={flushAutosave} /></C.Field>
            {isAdmin ? <C.Button variant="ghost" icon={Trash2} aria-label={s.removeInboundPort} disabled={busy} onClick={() => removePort(index)} /> : null}
          </div>)}
        </div> : <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{s.noInboundPorts}</p>}
      </div> : null}
    </C.SettingsGroup>

    {/* Start, stop, restart and snapshot are not here any more. They are the project's row actions in the
        register, beside its removal, so every decision about a project is offered where the project is
        listed rather than two screens deeper. What is left below is what only this drawer can do: the
        repair for a container the runtime can no longer verify, and restoring a complete snapshot.
        Deleting the project was never an environment control and lives in that same row menu. */}
    <div className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto">
      {stale ? <C.Button disabled={busy} onClick={() => report(mutate.mutateAsync({ kind: 'recreate' }))}>{s.recreateEnvironment}</C.Button> : null}
      {watched && !progressOpen ? (
        <C.Button variant="ghost" onClick={() => setProgressOpen(true)}>{host.t.operationProgress.actions[operationAction] ?? s.startEnvironment}</C.Button>
      ) : null}
    </div>
    <C.Field label={s.snapshots}>
      {completeSnapshots.length ? <div className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto"><C.SelectMenu label={s.snapshots} value={snapshotId} onChange={setSnapshotId} options={completeSnapshots.map((item) => ({ value: item.id, label: `${item.createdAt}${item.note ? `: ${item.note}` : ''}` }))} /><C.Button disabled={busy || !completeSnapshots.some((item) => item.id === snapshotId)} onClick={() => setConfirm({ kind: 'restore', snapshotId })}>{s.restoreEnvironment}</C.Button></div> : <p className="text-xs text-muted-foreground">{s.noSnapshots}</p>}
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
