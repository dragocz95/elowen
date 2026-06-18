import type { Task, Session, Mission, CreateTaskInput, UpdateTaskInput, PlanInput, PlanResult, EngageInput, OrcaConfig, ConfigPatch, MissionDetail, User, AuthResult, ActivityEvent, Project, ProjectGit } from './types';
import { getToken, clearToken } from './token';

export const BASE = process.env.NEXT_PUBLIC_ORCA_URL ?? 'http://localhost:4400';

export class OrcaApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'OrcaApiError'; }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) { clearToken(); throw new OrcaApiError(`orca 401 on ${path}`, 401); }
  if (!res.ok) {
    let code: string | undefined;
    try { code = ((await res.json()) as { error?: string }).error; } catch { /* non-JSON body */ }
    throw new OrcaApiError(`orca ${res.status} on ${path}`, res.status, code);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const orcaClient = {
  tasks: () => req<Task[]>('/tasks'),
  ready: () => req<Task[]>('/tasks/ready'),
  sessions: () => req<string[]>('/sessions'),
  missions: () => req<Mission[]>('/missions'),
  getMissionDetail: (id: string) => req<MissionDetail>(`/missions/${encodeURIComponent(id)}`),
  health: () => req<{ ok: boolean }>('/health'),
  createTask: (input: CreateTaskInput) => req<Task>('/tasks', json(input)),
  updateTask: (id: string, patch: UpdateTaskInput) => req<Task>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  taskDeps: (id: string) => req<string[]>(`/tasks/${encodeURIComponent(id)}/deps`),
  allDeps: () => req<{ task_id: string; depends_on_id: string }[]>('/tasks/deps'),
  planTask: (input: PlanInput) => req<PlanResult>('/tasks/plan', json(input)),
  planPreview: (input: { goal: string; prompt?: string }) => req<{ phases: { title: string; type: string; agent?: string; details?: string }[] }>('/tasks/plan', json({ ...input, dryRun: true })),
  engage: (input: EngageInput) => req<Mission>('/missions', json(input)),
  spawn: (input: { taskId: string; exec?: string }) => req<{ session: string }>('/sessions', json(input)),
  closeTask: (id: string) => req<Task>(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) }),
  setTaskStatus: (id: string, status: string) => req<Task>(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }),
  setTaskExec: (id: string, exec: string) => req<Task>(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exec }) }),
  sessionPane: (name: string, ansi = false) => req<{ pane: string }>(`/sessions/${encodeURIComponent(name)}/pane${ansi ? '?ansi=1' : ''}`),
  killSession: (name: string) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  sendKeys: (name: string, keys: string[]) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/keys`, json({ keys })),
  resizeSession: (name: string, cols: number, rows: number) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/resize`, json({ cols, rows })),
  pauseMission: (id: string) => req<Mission>(`/missions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) }),
  resumeMission: (id: string) => req<Mission>(`/missions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) }),
  disengageMission: (id: string) => req<{ ok: boolean }>(`/missions/${id}`, { method: 'DELETE' }),
  getConfig: () => req<OrcaConfig>('/config'),
  updateConfig: (patch: ConfigPatch) => req<OrcaConfig>('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  login: (username: string, password: string) => req<AuthResult>('/auth/login', json({ username, password })),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => req<{ user: User }>('/auth/me'),
  listUsers: () => req<User[]>('/users'),
  createUser: (username: string, password: string) => req<User>('/users', json({ username, password })),
  deleteUser: (id: number) => req<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  activity: (opts?: { limit?: number; type?: string }) => req<ActivityEvent[]>(`/activity?${new URLSearchParams({ ...(opts?.limit ? { limit: String(opts.limit) } : {}), ...(opts?.type ? { type: opts.type } : {}) }).toString()}`),
  projects: () => req<Project[]>('/projects'),
  createProject: (v: { slug: string; path: string; notes?: string }) => req<Project>('/projects', json(v)),
  projectGit: (id: number) => req<ProjectGit>(`/projects/${id}/git`),
};
export type { Session };
