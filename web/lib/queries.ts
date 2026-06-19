import { useQuery } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';
import type { DerivedSignal, HermesStatus, CliDetectionResult } from './types';

export const QUERY_KEYS = {
  tasks: ['tasks'] as const,
  sessions: ['sessions'] as const,
  missions: ['missions'] as const,
  health: ['health'] as const,
  config: ['config'] as const,
  sessionSignals: ['session-signals'] as const,
  hermesStatus: ['hermes-status'] as const,
};

/** Latest derived signal per session, populated by the SSE stream (see useOrcaEvents). */
export const useSessionSignals = (): Record<string, DerivedSignal> => {
  const { data } = useQuery<Record<string, DerivedSignal>>({ queryKey: QUERY_KEYS.sessionSignals, queryFn: () => ({}), staleTime: Infinity, initialData: {} });
  return data;
};

export const useSessionSignal = (name: string): DerivedSignal | undefined => useSessionSignals()[name];

export const useTasks = () =>
  useQuery({ queryKey: QUERY_KEYS.tasks, queryFn: orcaClient.tasks, refetchInterval: 5000 });

export const useSessions = () =>
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
    refetchInterval: live ? 8000 : false,
    staleTime: live ? 0 : 5 * 60 * 1000,
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

export const useMissionDetail = (id: string | null) =>
  useQuery({
    queryKey: ['mission', id],
    queryFn: () => orcaClient.getMissionDetail(id as string),
    enabled: !!id,
  });

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: orcaClient.listUsers });

export const useActivity = (type?: string) =>
  useQuery({ queryKey: ['activity', type ?? 'all'], queryFn: () => orcaClient.activity(type ? { type } : undefined), refetchInterval: 5000 });

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

export const useProjectChanges = (id: number | null, enabled: boolean) =>
  useQuery({ queryKey: ['project-changes', id], queryFn: () => orcaClient.projectChanges(id as number), enabled: !!id && enabled });

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
