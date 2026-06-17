import { useQuery } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';

export const QUERY_KEYS = {
  tasks: ['tasks'] as const,
  sessions: ['sessions'] as const,
  missions: ['missions'] as const,
  health: ['health'] as const,
};

export const useTasks = () =>
  useQuery({ queryKey: QUERY_KEYS.tasks, queryFn: orcaClient.tasks });

export const useSessions = () =>
  useQuery({ queryKey: QUERY_KEYS.sessions, queryFn: orcaClient.sessions });

export const useMissions = () =>
  useQuery({ queryKey: QUERY_KEYS.missions, queryFn: orcaClient.missions });

export const useHealth = () =>
  useQuery({
    queryKey: QUERY_KEYS.health,
    queryFn: orcaClient.health,
    refetchInterval: 10000,
  });
