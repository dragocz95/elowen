import { useCallback, useRef, useState } from 'react';
import { acknowledgeEnvironmentRequest, environmentRequest } from './environmentRequest';
import type { EnvironmentAction, EnvironmentOperation, ProjectEnvironment } from '../../../src/plugins/environmentTypes';
import { jsonBody, localizedError, runtime, type Project } from './runtime';

/** What the project register shows and offers for a managed project.
 *
 *  The register row belongs to core; what runs behind it belongs here. The host asks this hook once per
 *  render with the rows on screen, and gets back one state per project and the lifecycle actions that
 *  state allows. The four buttons this replaces used to live in the environment drawer, two screens away
 *  from the register that lists the project.
 *
 *  Nothing polls. Each row's state is one read of the plugin's own status route, and the daemon's pushed
 *  `environment-operation` frames already invalidate the host's query cache on every step, so a start
 *  observed from a terminal, a tool or another browser reaches this row the same way it reaches the
 *  drawer. */

type EnvironmentState = ProjectEnvironment['state'];

/** How a state reads on a row: the glyph core draws, its tone, and whether something is in flight. The
 *  wording is the plugin's own `state_*` string, which is already translated in every locale. */
const STATE_PRESENTATION: Record<EnvironmentState, { icon: string; tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger'; busy?: boolean }> = {
  running: { icon: 'CircleDot', tone: 'success' },
  starting: { icon: 'CircleDot', tone: 'accent', busy: true },
  stopped: { icon: 'Circle', tone: 'muted' },
  unprovisioned: { icon: 'CircleDashed', tone: 'muted' },
  failed: { icon: 'CircleAlert', tone: 'danger' },
  deleting: { icon: 'CircleSlash', tone: 'warning', busy: true },
  deleted: { icon: 'CircleSlash', tone: 'muted' },
};

/** The four lifecycle actions a row offers, and the states each one is FOR. A stop offered on a stopped
 *  environment is a request the runtime would refuse, so the item is present and unselectable rather
 *  than appearing and disappearing under the pointer as the state changes. */
const ACTIONS: { kind: 'start' | 'stop' | 'restart' | 'snapshot'; label: string; icon: string; states: EnvironmentState[]; confirm?: boolean }[] = [
  { kind: 'start', label: 'startEnvironment', icon: 'Play', states: ['stopped', 'unprovisioned', 'failed'] },
  { kind: 'stop', label: 'stopEnvironment', icon: 'Square', states: ['running'], confirm: true },
  { kind: 'restart', label: 'restartEnvironment', icon: 'RotateCcw', states: ['running', 'stopped', 'starting', 'failed'] },
  { kind: 'snapshot', label: 'snapshotEnvironment', icon: 'Camera', states: ['running', 'stopped'], confirm: true },
];

const IN_FLIGHT: EnvironmentState[] = ['starting', 'deleting'];

export function useProjectRowContribution({ projects }: { projects: Project[] }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const host = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const managed = projects.filter((project) => project.executionKind === 'managed' && project.lifecycle !== 'deleting');
  const me = hooks.useQuery<{ user: { id: number } | null }>({ queryKey: ['me'], queryFn: () => api('/auth/me') });
  const accountId = me.data?.user?.id;
  const states = hooks.useQueries({
    queries: managed.map((project) => ({
      queryKey: ['plugin', 'sandbox', 'environment-state', project.id],
      queryFn: () => api(`/plugins/sandbox/api/environments/status?projectId=${project.id}`),
      // A row whose environment the account may not read simply carries no state: the register is not
      // the place to report an access decision the project list already made.
      retry: false,
    })),
  }) as { data?: ProjectEnvironment }[];

  const [confirm, setConfirm] = useState<{ projectId: number; action: EnvironmentAction } | null>(null);
  const [watched, setWatched] = useState<{ projectId: number; operationId: string; kind: string } | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const progress = hooks.useEnvironmentOperation(watched?.operationId ?? null, watched?.projectId);

  // The row menu the host renders is the frame this hook published last, so a handler must not close
  // over the figures of the render that produced it. Everything a dispatch needs is read from here.
  const generations = useRef(new Map<number, number>());
  managed.forEach((project, index) => {
    const generation = states[index]?.data?.generation;
    if (generation !== undefined) generations.current.set(project.id, generation);
  });
  const accountRef = useRef<number | undefined>(accountId);
  accountRef.current = accountId;

  const dispatch = useCallback(async (projectId: number, action: EnvironmentAction) => {
    const account = accountRef.current;
    if (!account) { toast(s.error_project_forbidden, 'error'); return; }
    const generation = generations.current.get(projectId) ?? 1;
    setPending(projectId);
    let request: { requestId: string; expectedGeneration: number } | null = null;
    try {
      request = environmentRequest(account, projectId, JSON.stringify(action), generation);
      const operation = await api(`/plugins/sandbox/api/projects/${projectId}/environment`, jsonBody({ action, ...request })) as EnvironmentOperation & { requestId: string };
      acknowledgeEnvironmentRequest(account, projectId, [operation.requestId]);
      setWatched({ projectId, operationId: operation.id, kind: action.kind });
      setProgressOpen(true);
      setConfirm(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'environment-state', projectId] }),
        qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'project-environment', projectId] }),
      ]);
    } catch (error) {
      // A definitive refusal never accepted the intent, so its idempotency key must not outlive it and
      // block the next attempt. Unknown outcomes keep theirs, which is what makes a retry safe.
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (request && [400, 401, 403, 404, 422].includes(status)) acknowledgeEnvironmentRequest(account, projectId, [request.requestId]);
      toast(localizedError(error, s), 'error');
    } finally {
      setPending(null);
    }
  }, [api, qc, s, toast]);

  const status: Record<number, { label: string; icon: string; tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger'; busy?: boolean }> = {};
  const actions: Record<number, { id: string; label: string; icon: string; disabled?: boolean; onSelect: () => void }[]> = {};
  managed.forEach((project, index) => {
    const environment = states[index]?.data;
    if (!environment) return;
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
    actions[project.id] = ACTIONS.map((action) => ({
      id: action.kind,
      label: s[action.label] || action.kind,
      icon: action.icon,
      disabled: busy || IN_FLIGHT.includes(state) || !action.states.includes(state),
      onSelect: () => {
        if (action.confirm) setConfirm({ projectId: project.id, action: { kind: action.kind } as EnvironmentAction });
        else void dispatch(project.id, { kind: action.kind } as EnvironmentAction);
      },
    }));
  });

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
        onRetry={() => { if (watched) void dispatch(watched.projectId, { kind: watched.kind } as EnvironmentAction); }}
        onSettled={() => {
          const projectId = watched?.projectId;
          setWatched(null);
          if (projectId !== undefined) void qc.invalidateQueries({ queryKey: ['plugin', 'sandbox', 'environment-state', projectId] });
        }}
        onClose={({ running }: { running: boolean }) => { setProgressOpen(false); if (!running) setWatched(null); }}
      />
    </>
  );

  return { status, actions, overlay };
}
