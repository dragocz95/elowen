import { useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';
import { pendingEscalations, type Escalation } from './escalations';
import type { DerivedSignal, HermesStatus, CliDetectionResult, GithubAuthStatus, PlanJob } from './types';

/** Poll an async plan job until it leaves the 'planning' state. The SSE `plan` handler also pushes
 *  updates into this cache (keyed by jobId) so the poll is a fallback. Disabled when jobId is null. */
export function usePlanJob(jobId: string | null) {
  return useQuery<PlanJob>({
    queryKey: ['plan-job', jobId],
    queryFn: () => orcaClient.getPlanJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === 'planning' ? 1000 : false),
  });
}

export const QUERY_KEYS = {
  tasks: ['tasks'] as const,
  sessions: ['sessions'] as const,
  missions: ['missions'] as const,
  health: ['health'] as const,
  config: ['config'] as const,
  sessionSignals: ['session-signals'] as const,
  hermesStatus: ['hermes-status'] as const,
  advisorStatus: ['advisor-status'] as const,
  system: ['system'] as const,
  usageByModel: ['usage-by-model'] as const,
};

/** The current user's advisor session state, polled so the dock reflects start/stop/crash. */
export const useAdvisorStatus = () =>
  useQuery({ queryKey: QUERY_KEYS.advisorStatus, queryFn: orcaClient.advisorStatus, refetchInterval: 5000 });

/** Latest derived signal per session, populated by the SSE stream (see useOrcaEvents). */
export const useSessionSignals = (): Record<string, DerivedSignal> => {
  const { data } = useQuery<Record<string, DerivedSignal>>({ queryKey: QUERY_KEYS.sessionSignals, queryFn: () => ({}), staleTime: Infinity, initialData: {} });
  return data;
};

export const useSessionSignal = (name: string): DerivedSignal | undefined => useSessionSignals()[name];

export const useTasks = (projectId?: number) =>
  // A bare `useTasks()` keeps the shared `['tasks']` cache key (Kanban/Timeline/Sidebar/… all share
  // one "all tasks" fetch). A scoped `useTasks(projectId)` gets its own entry so a project-filtered
  // Tasks view doesn't replace the global cache. Prefix invalidations still hit both.
  useQuery({ queryKey: projectId == null ? QUERY_KEYS.tasks : ['tasks', projectId], queryFn: () => orcaClient.tasks(projectId), refetchInterval: 5000 });

/** Live session names — the stable handles used for liveness checks, signal keys and ops.
 *  Backed by the same query as useSessionInfos (one fetch); selects just the names. */
export const useSessions = () =>
  useQuery({ queryKey: QUERY_KEYS.sessions, queryFn: orcaClient.sessions, refetchInterval: 5000, select: (s) => s.map((x) => x.name) });

/** Live sessions with their daemon-classified role/identity, for display surfaces. */
export const useSessionInfos = () =>
  useQuery({ queryKey: QUERY_KEYS.sessions, queryFn: orcaClient.sessions, refetchInterval: 5000 });

export const useAllDeps = () =>
  useQuery({ queryKey: ['tasks', 'deps'], queryFn: orcaClient.allDeps });

/** Token/cost usage for a task's agent run. Polls while the agent is live; for a finished task
 *  it's fetched once and cached (the numbers no longer change). */
export const useTaskUsage = (taskId: string, live = false) =>
  useQuery({
    queryKey: ['task-usage', taskId],
    queryFn: () => orcaClient.taskUsage(taskId),
    enabled: !!taskId,
    refetchInterval: live ? 5000 : false,
    staleTime: live ? 0 : 5 * 60 * 1000,
  });

/** Total token/cost usage aggregated per model, for the stats page. Cost/tokens move slowly. */
export const useModelUsage = (projectId?: number) =>
  useQuery({
    queryKey: projectId == null ? QUERY_KEYS.usageByModel : ['usage-by-model', projectId],
    queryFn: () => orcaClient.usageByModel(projectId),
    refetchInterval: 30_000,
  });

export const useMissions = () =>
  useQuery({ queryKey: QUERY_KEYS.missions, queryFn: orcaClient.missions });

export const useHealth = () =>
  useQuery({
    queryKey: QUERY_KEYS.health,
    queryFn: orcaClient.health,
    refetchInterval: 10000,
  });

export const useConfig = () =>
  useQuery({ queryKey: QUERY_KEYS.config, queryFn: orcaClient.getConfig });

/** Orca's version + update posture for the System settings panel. Polled so an "update available"
 *  badge appears without a reload, and so the version flips after a manual/auto update + restart. */
export const useSystem = () =>
  useQuery({ queryKey: QUERY_KEYS.system, queryFn: orcaClient.system, refetchInterval: 60000 });

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: orcaClient.listUsers });

export const useActivity = (type?: string) =>
  useQuery({ queryKey: ['activity', type ?? 'all'], queryFn: () => orcaClient.activity(type ? { type } : undefined), refetchInterval: 5000 });

/** Pending overseer escalations — phases a post-done review rejected that still need a human, derived
 *  from the persisted review feed joined to live task/dep state. Shared by the Escalations page, the
 *  sidebar alert and the notification bell so the count is one source of truth. */
export const useEscalations = (): Escalation[] => {
  const reviews = useActivity('review');
  const tasks = useTasks();
  const deps = useAllDeps();
  return useMemo(
    () => pendingEscalations(reviews.data ?? [], tasks.data ?? [], deps.data ?? []),
    [reviews.data, tasks.data, deps.data],
  );
};

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: orcaClient.projects });

export const useProjectGit = (id: number | null) =>
  useQuery({ queryKey: ['project-git', id], queryFn: () => orcaClient.projectGit(id as number), enabled: !!id });

export const useProjectFiles = (id: number | null) =>
  useQuery({ queryKey: ['project-files', id], queryFn: () => orcaClient.projectFiles(id as number), enabled: !!id });

export const useProjectFile = (id: number | null, path: string | null) =>
  useQuery({ queryKey: ['project-file', id, path], queryFn: () => orcaClient.projectFile(id as number, path as string), enabled: !!id && !!path });

export const useProjectCommit = (id: number | null, hash: string | null) =>
  useQuery({ queryKey: ['project-commit', id, hash], queryFn: () => orcaClient.projectCommit(id as number, hash as string), enabled: !!id && !!hash });

export const useProjectFileAtHead = (id: number | null, path: string | null, enabled: boolean) =>
  useQuery({ queryKey: ['project-head', id, path], queryFn: () => orcaClient.projectFileAtHead(id as number, path as string), enabled: !!id && !!path && enabled });

export const useProjectCommitFileDiff = (id: number | null, hash: string | null, path: string | null) =>
  useQuery({ queryKey: ['project-commit-file', id, hash, path], queryFn: () => orcaClient.projectCommitFileDiff(id as number, hash as string, path as string), enabled: !!id && !!hash && !!path });

export const useProjectChanged = (id: number | null) =>
  useQuery({ queryKey: ['project-changed', id], queryFn: () => orcaClient.projectChanged(id as number), enabled: !!id });

/** Lazy diff of one file from a task's frozen change list — fetched only when the user opens it. */
export const useTaskChangedFileDiff = (taskId: string | null, path: string | null) =>
  useQuery({ queryKey: ['task-changed-diff', taskId, path], queryFn: () => orcaClient.taskChangedFileDiff(taskId as string, path as string), enabled: !!taskId && !!path });

/** Handoff notes for a mission (keyed by epic id), shown read-only in the detail pane. */
export const useMissionNotes = (target: string | null) =>
  useQuery({ queryKey: ['mission-notes', target], queryFn: () => orcaClient.missionNotes(target as string), enabled: !!target, refetchInterval: 10000 });

export const useProjectChanges = (id: number | null, enabled: boolean) =>
  useQuery({ queryKey: ['project-changes', id], queryFn: () => orcaClient.projectChanges(id as number), enabled: !!id && enabled });

/** Commit history across several projects, merged into one time-sorted stream tagged with projectId,
 *  for the timeline's "changes over time" view. Each commit older than the window is dropped so the
 *  stream lines up with the axis above it. */
export const useProjectsCommits = (projectIds: number[], hours: number) =>
  useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['project-commits', id],
      queryFn: () => orcaClient.projectCommits(id, 25),
      // Commits change on the scale of a push, not seconds — poll lazily to keep the timeline's
      // background git fan-out (one `git log` per project) light.
      refetchInterval: 60000,
      staleTime: 30000,
    })),
    combine: (results) => {
      const cutoff = Date.now() - hours * 3600_000;
      const commits = results
        .flatMap((r, i) => (r.data?.commits ?? []).map((c) => ({ ...c, projectId: projectIds[i] })))
        .filter((c) => c.timestamp >= cutoff)
        .sort((a, b) => b.timestamp - a.timestamp);
      return { commits, isLoading: results.some((r) => r.isLoading) };
    },
  });

export const useMe = () =>
  useQuery({ queryKey: ['me'], queryFn: orcaClient.me, staleTime: 5 * 60 * 1000 });

export const useUserProjects = (userId: number | null, enabled = true) =>
  useQuery({ queryKey: ['user-projects', userId], queryFn: () => orcaClient.userProjects(userId as number), enabled: !!userId && enabled });

export const useHermesStatus = (home?: string) =>
  useQuery<HermesStatus>({
    queryKey: home ? ['hermes-status', home] : QUERY_KEYS.hermesStatus,
    queryFn: () => orcaClient.hermesStatus(home),
    retry: false,
  });

export const useCliStatus = () =>
  useQuery<CliDetectionResult>({
    queryKey: ['cli-status'],
    queryFn: orcaClient.cliStatus,
    refetchInterval: 30000,
    retry: false,
  });

export const useGithubStatus = () =>
  useQuery<GithubAuthStatus>({
    queryKey: ['github-status'],
    queryFn: orcaClient.githubStatus,
    refetchInterval: 30000,
    retry: false,
  });
