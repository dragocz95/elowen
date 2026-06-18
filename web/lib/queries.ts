import { useQuery } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';
import type { DerivedSignal } from './types';

export const QUERY_KEYS = {
  tasks: ['tasks'] as const,
  sessions: ['sessions'] as const,
  missions: ['missions'] as const,
  health: ['health'] as const,
  config: ['config'] as const,
  sessionSignals: ['session-signals'] as const,
};

/** Latest derived signal per session, populated by the SSE stream (see useOrcaEvents). */
export const useSessionSignal = (name: string): DerivedSignal | undefined => {
  const { data } = useQuery<Record<string, DerivedSignal>>({ queryKey: QUERY_KEYS.sessionSignals, queryFn: () => ({}), staleTime: Infinity, initialData: {} });
  return data[name];
};

export const useTasks = () =>
  useQuery({ queryKey: QUERY_KEYS.tasks, queryFn: orcaClient.tasks, refetchInterval: 5000 });

export const useSessions = () =>
  useQuery({ queryKey: QUERY_KEYS.sessions, queryFn: orcaClient.sessions, refetchInterval: 5000 });

export const useAllDeps = () =>
  useQuery({ queryKey: ['tasks', 'deps'], queryFn: orcaClient.allDeps });

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
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: orcaClient.me });

export const useActivity = (type?: string) =>
  useQuery({ queryKey: ['activity', type ?? 'all'], queryFn: () => orcaClient.activity(type ? { type } : undefined), refetchInterval: 5000 });

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: orcaClient.projects });

export const useProjectGit = (id: number | null) =>
  useQuery({ queryKey: ['project-git', id], queryFn: () => orcaClient.projectGit(id as number), enabled: !!id });
