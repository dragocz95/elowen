'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';
import { QUERY_KEYS } from './queries';

export function useSpawn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; exec?: string }) => orcaClient.spawn(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: unknown) => orcaClient.createTask(input), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useCloseTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.closeTask(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useSetTaskStatus() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string; status: string }) => orcaClient.setTaskStatus(v.id, v.status), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useKillSession() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => orcaClient.killSession(name), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }) });
}
export function useSendInput() {
  return useMutation({ mutationFn: (v: { name: string; keys: string[] }) => orcaClient.sendKeys(v.name, v.keys) });
}
export function useEngage() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: unknown) => orcaClient.engage(input), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function usePauseMission() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.pauseMission(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useResumeMission() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.resumeMission(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useDisengage() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.disengageMission(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
