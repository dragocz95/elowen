import type { Task, Session, Mission } from './types';

export const BASE = process.env.NEXT_PUBLIC_ORCA_URL ?? 'http://localhost:4400';

export class OrcaApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'OrcaApiError'; }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new OrcaApiError(`orca ${res.status} on ${path}`, res.status);
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const orcaClient = {
  tasks: () => req<Task[]>('/tasks'),
  ready: () => req<Task[]>('/tasks/ready'),
  sessions: () => req<string[]>('/sessions'),
  missions: () => req<Mission[]>('/missions'),
  health: () => req<{ ok: boolean }>('/health'),
  createTask: (input: unknown) => req<Task>('/tasks', json(input)),
  engage: (input: unknown) => req<Mission>('/missions', json(input)),
  spawn: (input: { taskId: string; exec?: string }) => req<{ session: string }>('/sessions', json(input)),
  closeTask: (id: string) => req<Task>(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) }),
  setTaskStatus: (id: string, status: string) => req<Task>(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }),
  killSession: (name: string) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  sendKeys: (name: string, keys: string[]) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/keys`, json({ keys })),
  pauseMission: (id: string) => req<Mission>(`/missions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) }),
  resumeMission: (id: string) => req<Mission>(`/missions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) }),
  disengageMission: (id: string) => req<{ ok: boolean }>(`/missions/${id}`, { method: 'DELETE' }),
};
export type { Session };
