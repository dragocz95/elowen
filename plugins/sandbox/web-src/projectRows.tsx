import { useCallback, useEffect, useRef, useState } from 'react';
import { dispatchEnvironmentAction } from './environmentRequest';
import type { EnvironmentAction, ProjectEnvironment } from '../../../src/plugins/environmentTypes';
import { jsonBody, runtime, type Project } from './runtime';

/** What the project register shows and offers for a managed project.
 *
 *  The register row belongs to core; what runs behind it belongs here. The host asks this hook once per
 *  render with the rows on screen. One batch read supplies lifecycle state and resource usage for every
 *  managed row, while pushed environment-operation frames still invalidate that shared cache immediately. */

type EnvironmentState = ProjectEnvironment['state'];
type MetricState = 'ready' | 'sampling' | 'stopped' | 'unavailable';
interface UsageMetric {
  state: MetricState;
  usedCpus?: number | null;
  percent?: number | null;
  usedBytes?: number | null;
  limitBytes: number | null;
}
interface ProjectUsage {
  projectId: number;
  environment: ProjectEnvironment;
  resources: { cpu: UsageMetric; memory: UsageMetric; disk: UsageMetric };
}
interface UsageBatch { sampledAt: string; projects: ProjectUsage[] }
interface RowMetric { id: string; label: string; value: string; valueText?: string; percent?: number; state: 'ready' | 'absolute' | 'unknown' | 'stopped' | 'unavailable' }
/** The snapshot shape the host draws in BOTH the register row and the project drawer. The figures are
 *  always the last ones actually measured; `refreshing` and `stale` describe the read around them. */
interface RowMetrics { label: string; items: RowMetric[]; refreshing?: boolean; stale?: boolean; staleLabel?: string; onRefresh?: () => void; refreshLabel?: string }

const STATE_PRESENTATION: Record<EnvironmentState, { icon: string; tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger'; busy?: boolean }> = {
  running: { icon: 'Play', tone: 'success' },
  starting: { icon: 'Loader2', tone: 'accent', busy: true },
  stopped: { icon: 'Square', tone: 'muted' },
  unprovisioned: { icon: 'CircleDashed', tone: 'muted' },
  failed: { icon: 'TriangleAlert', tone: 'danger' },
  deleting: { icon: 'Loader2', tone: 'warning', busy: true },
  deleted: { icon: 'CircleSlash', tone: 'muted' },
};

const ACTIONS: { kind: 'start' | 'stop' | 'restart' | 'snapshot'; label: string; icon: string; states: EnvironmentState[]; confirm?: boolean }[] = [
  { kind: 'start', label: 'startEnvironment', icon: 'Play', states: ['stopped', 'unprovisioned', 'failed'] },
  { kind: 'stop', label: 'stopEnvironment', icon: 'Square', states: ['running'], confirm: true },
  { kind: 'restart', label: 'restartEnvironment', icon: 'RotateCcw', states: ['running', 'stopped', 'starting', 'failed'] },
  { kind: 'snapshot', label: 'snapshotEnvironment', icon: 'Camera', states: ['running', 'stopped'], confirm: true },
];

const IN_FLIGHT: EnvironmentState[] = ['starting', 'deleting'];
/** The prefix every resource cache of this plugin shares. The project ids follow it, so one account's
 *  page has exactly ONE resource cache and a refusal can find every other one. */
const USAGE_QUERY_PREFIX = ['plugin', 'sandbox', 'project-row-usage'];
const isUsageQueryKey = (key: unknown): boolean =>
  Array.isArray(key) && USAGE_QUERY_PREFIX.every((part, index) => key[index] === part);
export const PROJECT_USAGE_QUERY_POLICY = Object.freeze({
  staleTime: 25_000,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
/** What a resource with nothing measured behind it reads as. Deliberately a mark rather than a word: the
 *  register used to print "Loading…" in all three slots of every managed card until the first batch came
 *  back, and a page of that is unreadable at three cards across. The host draws the ring either way, so
 *  the shape is on screen from the first commit and only the figure inside it changes. It is never a
 *  zero — an environment whose sample has not arrived is not an environment using none of its share. */
const UNKNOWN_VALUE = '—';
const formatBytes = (bytes: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 10 || unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
};

const metricLabel = (kind: 'cpu' | 'memory' | 'disk', s: Record<string, string>): string =>
  kind === 'cpu' ? s.usageCpu : kind === 'memory' ? s.usageRam : s.usageDisk;

/** Only for a project nothing has been measured for YET. A project that HAS a sample keeps it through a
 *  failed or in-flight read, marked rather than replaced — a placeholder over real figures is how a
 *  populated environment briefly reported nothing every time the batch was re-read. */
function placeholderMetrics(s: Record<string, string>, state: 'unknown' | 'unavailable', value: string): RowMetrics {
  return {
    label: s.resources,
    items: (['cpu', 'memory', 'disk'] as const).map((kind) => ({ id: kind, label: metricLabel(kind, s), value, state })),
  };
}

function metricValue(metric: UsageMetric, kind: 'cpu' | 'memory' | 'disk', s: Record<string, string>): RowMetric {
  const label = metricLabel(kind, s);
  // The runtime is taking the sample right now, which is a wait rather than a figure. It reads as the
  // same honest unknown as a sample that has not been asked for yet: the ring is drawn, and nothing in
  // it is claimed.
  if (metric.state === 'sampling') return { id: kind, label, value: UNKNOWN_VALUE, state: 'unknown' };
  if (metric.state === 'stopped') return { id: kind, label, value: s.usageStopped, state: 'stopped' };
  if (metric.state !== 'ready') return { id: kind, label, value: s.usageUnavailable, state: 'unavailable' };
  if (kind === 'cpu') {
    // Rendered from the CLAMPED figure, not the raw one: a reported 140 % is drawn as a full ring, and a
    // figure beside it saying 140 would be the ring and the text disagreeing about the same reading.
    const percent = clampPercent(metric.percent ?? 0);
    const value = `${Math.round(percent)}%`;
    return { id: kind, label, value, valueText: `${label}: ${value}`, percent, state: 'ready' };
  }
  const used = formatBytes(metric.usedBytes ?? 0);
  // No ceiling could be read at all — an environment whose disk was never materialized, or a volume the
  // runtime could not measure. The used figure is a complete measurement on its own and is reported as
  // itself: `1.2 GiB / ?` puts a ceiling on screen that does not exist, and a percentage of nothing would
  // have to be invented.
  if (metric.limitBytes === null) return { id: kind, label, value: used, valueText: `${label}: ${used}. ${s.usageLimitUnknown}`, state: 'absolute' };
  const limit = formatBytes(metric.limitBytes);
  const percent = clampPercent(metric.limitBytes > 0 ? (metric.usedBytes ?? 0) / metric.limitBytes * 100 : 0);
  const value = `${used} / ${limit}`;
  // Memory's ceiling is the environment's own configured limit; disk's is the volume it is stored on,
  // which is a real ceiling it genuinely cannot grow past but NOT a per-project quota. Same reading, so
  // the register draws one meter for both, and the difference is said rather than left to be assumed.
  const valueText = kind === 'disk' ? `${label}: ${value}. ${s.usageDiskVolume}` : `${label}: ${value}`;
  return { id: kind, label, value, valueText, percent, state: 'ready' };
}

export function useProjectRowContribution({ projects }: { projects: Project[] }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const host = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  // The host hands this hook the account's whole authorized project list rather than the rows a search
  // happens to leave, so `managedIds` — and therefore the cache key below — is a page-level fact that does
  // not move while someone types in the filter box. Keying on the filtered set gave every keystroke its own
  // cache entry and its own batch request, and an open drawer lost the snapshot it was showing the moment
  // the search stopped matching its project.
  const managed = projects.filter((project) => project.executionKind === 'managed' && project.lifecycle !== 'deleting');
  const managedIds = managed.map((project) => project.id).sort((a, b) => a - b);
  const usageQueryKey = [...USAGE_QUERY_PREFIX, ...managedIds];
  const usage = hooks.useQuery<UsageBatch>({
    queryKey: usageQueryKey,
    // React Query's own signal, so a read this client no longer needs is actually abandoned at the socket
    // rather than left to complete into a cache nobody reads.
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api('/plugins/sandbox/api/environments/usage', { ...jsonBody({ projectIds: managedIds }), signal }) as Promise<UsageBatch>,
    enabled: managedIds.length > 0,
    // Registering or deleting a managed project changes the id list, and therefore the cache key, and a
    // new key has no data of its own. Without this the whole register emptied back to unknown rings for
    // the length of one batch because ONE project joined it. The last snapshot is carried across the
    // change instead; it is not written under the new key, so it is replaced rather than remembered, and
    // a project that is genuinely new to it simply has no entry and says so.
    placeholderData: (previous: UsageBatch | undefined) => previous,
    ...PROJECT_USAGE_QUERY_POLICY,
    retry: false,
  });
  const me = hooks.useQuery<{ user: { id: number } | null }>({ queryKey: ['me'], queryFn: () => api('/auth/me') as Promise<{ user: { id: number } | null }> });
  const accountId = me.data?.user?.id;
  // A refused read is not a failed one. `401`/`403` mean this account may no longer see these figures,
  // and the daemon re-resolves that membership on every batch precisely so a revoked assignment stops
  // reading host resource counters — so the cached sample is DROPPED rather than shown as stale.
  const refusedStatus = (usage.error as { status?: number } | undefined)?.status;
  const refused = usage.isError && (refusedStatus === 401 || refusedStatus === 403);
  // Every other failure keeps the last sample that actually arrived. Discarding it on any `isError`
  // replaced measured CPU, memory and disk with the word "Unavailable" the moment one poll missed, so a
  // running environment reported nothing until the next poll happened to succeed.
  const usageByProject = new Map((refused ? [] : usage.data?.projects ?? []).map((item) => [item.projectId, item]));
  const refreshing = usage.isFetching && !usage.isLoading;
  const stale = usage.isError && !refused && usageByProject.size > 0;
  const refresh = useCallback(() => {
    // `cancelRefetch: false` is what makes a second click a no-op while a read is in flight. The default
    // ABORTS the running request and starts another, so an impatient reader produced one host measurement
    // per click on the one control whose whole job is to produce a single fresh one.
    void qc.invalidateQueries({ queryKey: USAGE_QUERY_PREFIX }, { cancelRefetch: false });
  }, [qc]);

  // The last figure actually MEASURED for one resource of one project, keyed
  // `<projectId>:<generation>:<kind>`.
  //
  // A failed request is the rare case. The batch far more often answers `200` with one resource reporting
  // `unavailable` inside it — an unreadable cgroup file on a machine that is otherwise running, a disk tree
  // the helper could not walk — and replacing a real reading with the word "Unavailable" on that answer is
  // exactly the fault that replacing it on a failed request was. The measurement stays, the snapshot says
  // these are the last known figures, and "Unavailable" is shown only when there is nothing to keep.
  //
  // The GENERATION is part of the key because a recreated environment is a different machine with a
  // different process tree. Keeping "the last known CPU" across that boundary would show one generation's
  // figures for another's, which is a wrong reading rather than an old one.
  const measured = useRef(new Map<string, RowMetric>());
  const liveIds = new Set(managedIds);
  const currentGeneration = new Map<number, number>();
  for (const item of usageByProject.values()) currentGeneration.set(item.projectId, item.environment.generation);
  for (const key of [...measured.current.keys()]) {
    const [id, generation] = key.split(':');
    const projectId = Number(id);
    if (!liveIds.has(projectId)) { measured.current.delete(key); continue; }
    const live = currentGeneration.get(projectId);
    if (live !== undefined && String(live) !== generation) measured.current.delete(key);
  }
  // A refusal is not a gap to paper over: this account may no longer see these figures at all.
  if (refused) measured.current.clear();
  const recall = (projectId: number, generation: number, kind: 'cpu' | 'memory' | 'disk', metric: UsageMetric): { item: RowMetric; kept: boolean } => {
    const key = `${projectId}:${generation}:${kind}`;
    const fresh = metricValue(metric, kind, s);
    if (fresh.state === 'ready' || fresh.state === 'absolute') { measured.current.set(key, fresh); return { item: fresh, kept: false }; }
    // `stopped` is the truth about a resource that is not running to be measured, and it ENDS the life of
    // the figure before it — a reading from before the stop must not reappear when a later poll cannot read
    // the machine that was restarted since.
    if (fresh.state === 'stopped') { measured.current.delete(key); return { item: fresh, kept: false }; }
    // `unknown` and `unavailable` are both "no figure right now" over a resource that may well have one.
    if (fresh.state !== 'unavailable' && fresh.state !== 'unknown') return { item: fresh, kept: false };
    const kept = measured.current.get(key);
    return kept ? { item: kept, kept: true } : { item: fresh, kept: false };
  };

  /** Stamps the shared read state onto one project's figures. `keeping` is this project's own reason to be
   *  marked stale: the request succeeded, but part of what came back carried no figure. */
  const snapshot = (items: RowMetric[], keeping = false): RowMetrics => ({
    label: s.resources,
    items,
    ...(refreshing ? { refreshing: true } : {}),
    ...(stale || keeping ? { stale: true, staleLabel: s.usageStale } : {}),
    onRefresh: refresh,
    refreshLabel: s.usageRefresh,
  });

  // A refusal fences the ACTIVE read by dropping its data above. A cache entry left behind by an earlier
  // project set would still be there to answer, so every other resource cache of this plugin is removed
  // outright. The active key is deliberately left alone: removing a query its own observer is mounted on
  // only makes React Query fetch it again.
  const activeKey = JSON.stringify(usageQueryKey);
  useEffect(() => {
    if (!refused) return;
    qc.removeQueries({ predicate: (query: { queryKey: unknown }) => isUsageQueryKey(query.queryKey) && JSON.stringify(query.queryKey) !== activeKey });
  }, [refused, activeKey, qc]);

  const [confirm, setConfirm] = useState<{ projectId: number; action: EnvironmentAction } | null>(null);
  const [watched, setWatched] = useState<{ projectId: number; operationId: string; kind: string } | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const progress = hooks.useEnvironmentOperation(watched?.operationId ?? null, watched?.projectId);

  // The generation a lifecycle action is dispatched against is the one this frame was built from, so it
  // is read from the same map the remembered figures are keyed by rather than from a second copy of it.
  const generations = useRef(currentGeneration);
  generations.current = currentGeneration;
  const accountRef = useRef<number | undefined>(accountId);
  accountRef.current = accountId;

  const dispatch = useCallback(async (projectId: number, action: EnvironmentAction) => {
    const account = accountRef.current;
    if (!account) throw new Error(s.error_project_forbidden);
    setPending(projectId);
    try {
      const operation = await dispatchEnvironmentAction({ accountId: account, projectId, action, generation: generations.current.get(projectId) ?? 1, strings: s });
      setWatched({ projectId, operationId: operation.id, kind: action.kind });
      setProgressOpen(true);
      setConfirm(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: USAGE_QUERY_PREFIX }),
        qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'environment-state', projectId] }),
        qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'project-environment', projectId] }),
      ]);
    } finally {
      setPending(null);
    }
  }, [qc, s]);
  const dispatchAndReport = useCallback((projectId: number, action: EnvironmentAction) => {
    void dispatch(projectId, action).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'));
  }, [dispatch, toast]);

  const status: Record<number, { label: string; icon: string; tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger'; busy?: boolean }> = {};
  const metrics: Record<number, RowMetrics> = {};
  const actions: Record<number, { id: string; label: string; icon: string; disabled?: boolean; onSelect: () => void }[]> = {};
  for (const project of managed) {
    const item = usageByProject.get(project.id);
    if (!item) {
      // Nothing has ever been measured for this project, so there is nothing to preserve. Which of the
      // two placeholders applies is the difference between "the sample is not known yet" and "the read
      // failed" — and the first of those is a mark, not a word, so the card is readable while it waits.
      const failed = usage.isError && !usage.isLoading;
      metrics[project.id] = {
        ...placeholderMetrics(s, failed ? 'unavailable' : 'unknown',
          failed ? (refusedStatus === 403 ? s.error_project_forbidden : s.usageUnavailable) : UNKNOWN_VALUE),
        ...(refreshing ? { refreshing: true } : {}),
        onRefresh: refresh,
        refreshLabel: s.usageRefresh,
      };
      continue;
    }
    const environment = item.environment;
    const state = environment.state;
    const presentation = STATE_PRESENTATION[state] ?? STATE_PRESENTATION.unprovisioned;
    const busy = presentation.busy === true
      || pending === project.id
      || (watched?.projectId === project.id && ['pending', 'running'].includes(progress.operation?.status ?? ''));
    status[project.id] = {
      label: s[`state_${state}`] || state,
      icon: presentation.icon,
      tone: presentation.tone,
      ...(busy ? { busy: true } : {}),
    };
    // A machine that is BOOTING has no process figures yet, and the ones from before the boot belong to a
    // process that no longer exists — so they are forgotten here rather than kept as "last known". Disk
    // is storage rather than process state and survives a restart, which is why it is recalled normally.
    const booting = state === 'starting';
    const processMetric = (kind: 'cpu' | 'memory'): { item: RowMetric; kept: boolean } => {
      if (!booting) return recall(project.id, environment.generation, kind, item.resources[kind]);
      measured.current.delete(`${project.id}:${environment.generation}:${kind}`);
      return { item: { id: kind, label: metricLabel(kind, s), value: UNKNOWN_VALUE, state: 'unknown' }, kept: false };
    };
    const readings = [
      processMetric('cpu'),
      processMetric('memory'),
      recall(project.id, environment.generation, 'disk', item.resources.disk),
    ];
    metrics[project.id] = snapshot(readings.map((reading) => reading.item), readings.some((reading) => reading.kept));
    actions[project.id] = ACTIONS.map((action) => ({
      id: action.kind,
      label: s[action.label] || action.kind,
      icon: action.icon,
      disabled: busy || IN_FLIGHT.includes(state) || !action.states.includes(state),
      onSelect: () => {
        if (action.confirm) setConfirm({ projectId: project.id, action: { kind: action.kind } as EnvironmentAction });
        else dispatchAndReport(project.id, { kind: action.kind } as EnvironmentAction);
      },
    }));
  }

  const confirmLabel = confirm?.action.kind === 'snapshot' ? s.snapshotEnvironment : s.stopEnvironment;
  const watchedLabel = watched ? host.t.operationProgress.actions[watched.kind] ?? s.startEnvironment : '';
  const overlay = (
    <>
      <C.ConfirmDialog
        open={confirm !== null}
        title={confirmLabel}
        description={confirm?.action.kind === 'snapshot' ? s.snapshotWarning : s.stopWarning}
        confirmLabel={confirmLabel}
        pending={pending !== null}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { if (confirm) await dispatch(confirm.projectId, confirm.action); }}
      />
      <C.OperationProgressDialog
        open={progressOpen && watched !== null}
        title={watchedLabel}
        operation={progress.operation}
        logTail={progress.logTail}
        loadError={progress.loadError}
        onRetry={() => { if (watched) dispatchAndReport(watched.projectId, { kind: watched.kind } as EnvironmentAction); }}
        onSettled={() => {
          setWatched(null);
          void qc.invalidateQueries({ queryKey: USAGE_QUERY_PREFIX });
        }}
        onClose={({ running }: { running: boolean }) => { setProgressOpen(false); if (!running) setWatched(null); }}
      />
    </>
  );

  return { status, metrics, actions, overlay };
}
