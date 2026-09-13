import { useCallback, useRef, useState } from 'react';
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
interface RowMetric { id: string; label: string; value: string; valueText?: string; percent?: number; state: 'ready' | 'loading' | 'stopped' | 'unavailable' | 'unknown' }

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
export const PROJECT_USAGE_QUERY_POLICY = Object.freeze({
  staleTime: 25_000,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
const formatBytes = (bytes: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 10 || unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
};

function placeholderMetrics(s: Record<string, string>, state: 'loading' | 'unavailable', value: string) {
  return {
    label: s.resources,
    items: [
      { id: 'cpu', label: s.usageCpu, value, state },
      { id: 'memory', label: s.usageRam, value, state },
      { id: 'disk', label: s.usageDisk, value, state },
    ] as RowMetric[],
  };
}

function metricValue(metric: UsageMetric, kind: 'cpu' | 'memory' | 'disk', s: Record<string, string>): RowMetric {
  const label = kind === 'cpu' ? s.usageCpu : kind === 'memory' ? s.usageRam : s.usageDisk;
  if (metric.state === 'sampling') return { id: kind, label, value: s.usageSampling, state: 'loading' };
  if (metric.state === 'stopped') return { id: kind, label, value: s.usageStopped, state: 'stopped' };
  if (metric.state !== 'ready') return { id: kind, label, value: s.usageUnavailable, state: 'unavailable' };
  if (kind === 'cpu') {
    const percent = clampPercent(metric.percent ?? 0);
    const value = `${Math.round(metric.percent ?? 0)}%`;
    return { id: kind, label, value, valueText: `${label}: ${value}`, percent, state: 'ready' };
  }
  const used = formatBytes(metric.usedBytes ?? 0);
  if (metric.limitBytes === null) return { id: kind, label, value: `${used} / ?`, valueText: `${label}: ${used}. ${s.usageLimitUnknown}`, state: 'unknown' };
  const limit = formatBytes(metric.limitBytes);
  const percent = clampPercent(metric.limitBytes > 0 ? (metric.usedBytes ?? 0) / metric.limitBytes * 100 : 0);
  const value = `${used} / ${limit}`;
  return { id: kind, label, value, valueText: `${label}: ${value}`, percent, state: 'ready' };
}

export function useProjectRowContribution({ projects }: { projects: Project[] }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const host = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const managed = projects.filter((project) => project.executionKind === 'managed' && project.lifecycle !== 'deleting');
  const managedIds = managed.map((project) => project.id).sort((a, b) => a - b);
  const usageQueryKey = ['plugin', 'sandbox', 'project-row-usage', ...managedIds];
  const usage = hooks.useQuery<UsageBatch>({
    queryKey: usageQueryKey,
    queryFn: () => api('/plugins/sandbox/api/environments/usage', jsonBody({ projectIds: managedIds })) as Promise<UsageBatch>,
    enabled: managedIds.length > 0,
    ...PROJECT_USAGE_QUERY_POLICY,
    retry: false,
  });
  const me = hooks.useQuery<{ user: { id: number } | null }>({ queryKey: ['me'], queryFn: () => api('/auth/me') as Promise<{ user: { id: number } | null }> });
  const accountId = me.data?.user?.id;
  const usageByProject = new Map((usage.isError ? [] : usage.data?.projects ?? []).map((item) => [item.projectId, item]));

  const [confirm, setConfirm] = useState<{ projectId: number; action: EnvironmentAction } | null>(null);
  const [watched, setWatched] = useState<{ projectId: number; operationId: string; kind: string } | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const progress = hooks.useEnvironmentOperation(watched?.operationId ?? null, watched?.projectId);

  const generations = useRef(new Map<number, number>());
  generations.current.clear();
  for (const item of usageByProject.values()) generations.current.set(item.projectId, item.environment.generation);
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
        qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'project-row-usage'] }),
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
  const metrics: Record<number, { label: string; items: RowMetric[] }> = {};
  const actions: Record<number, { id: string; label: string; icon: string; disabled?: boolean; onSelect: () => void }[]> = {};
  for (const project of managed) {
    if (usage.isLoading) metrics[project.id] = placeholderMetrics(s, 'loading', s.usageLoading);
    else if (usage.isError) metrics[project.id] = placeholderMetrics(s, 'unavailable', (usage.error as { status?: number } | undefined)?.status === 403 ? s.error_project_forbidden : s.usageUnavailable);
    const item = usageByProject.get(project.id);
    if (!item) continue;
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
    metrics[project.id] = {
      label: s.resources,
      items: [
        state === 'starting' ? { id: 'cpu', label: s.usageCpu, value: s.usageLoading, state: 'loading' } : metricValue(item.resources.cpu, 'cpu', s),
        state === 'starting' ? { id: 'memory', label: s.usageRam, value: s.usageLoading, state: 'loading' } : metricValue(item.resources.memory, 'memory', s),
        metricValue(item.resources.disk, 'disk', s),
      ],
    };
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
          void qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'project-row-usage'] });
        }}
        onClose={({ running }: { running: boolean }) => { setProgressOpen(false); if (!running) setWatched(null); }}
      />
    </>
  );

  return { status, metrics, actions, overlay };
}
