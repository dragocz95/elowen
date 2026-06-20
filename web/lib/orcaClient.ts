import type { Task, Mission, CreateTaskInput, UpdateTaskInput, PlanInput, PlanSubmitResult, PlanJob, InsertPhasesInput, InsertPhasesResult, EngageInput, OrcaConfig, ConfigPatch, MissionDetail, User, UserPatch, ProfilePatch, AuthResult, ActivityEvent, Project, ProjectGit, HermesStatus, HermesInstallInput, HermesInstallResult, CliDetectionResult, TokenUsage, FileNode, SessionInfo } from './types';
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
  sessions: () => req<SessionInfo[]>('/sessions'),
  missions: () => req<Mission[]>('/missions'),
  getMissionDetail: (id: string) => req<MissionDetail>(`/missions/${encodeURIComponent(id)}`),
  health: () => req<{ ok: boolean }>('/health'),
  setupStatus: () => req<{ needsSetup: boolean }>('/setup'),
  createTask: (input: CreateTaskInput) => req<Task>('/tasks', json(input)),
  updateTask: (id: string, patch: UpdateTaskInput) => req<Task>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  taskDeps: (id: string) => req<string[]>(`/tasks/${encodeURIComponent(id)}/deps`),
  taskUsage: (id: string) => req<TokenUsage | null>(`/tasks/${encodeURIComponent(id)}/usage`),
  allDeps: () => req<{ task_id: string; depends_on_id: string }[]>('/tasks/deps'),
  planTask: (input: PlanInput) => req<PlanSubmitResult>('/tasks/plan', json(input)),
  planPreview: (input: { goal: string; prompt?: string }) => req<{ jobId: string }>('/tasks/plan', json({ ...input, dryRun: true })),
  getPlanJob: (jobId: string) => req<PlanJob>(`/plan/${encodeURIComponent(jobId)}`),
  insertPhases: (epicId: string, input: InsertPhasesInput) => req<InsertPhasesResult>(`/tasks/${encodeURIComponent(epicId)}/phases`, json(input)),
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
  updateMe: (patch: ProfilePatch) => req<User>('/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  uploadAvatar: (file: File) => { const fd = new FormData(); fd.append('avatar', file); return req<User>('/auth/me/avatar', { method: 'POST', body: fd }); },
  // Authenticated <img> src for a user's avatar (token in the query — an <img> can't set headers).
  avatarUrl: (id: number) => `${BASE}/users/${id}/avatar?token=${encodeURIComponent(getToken() ?? '')}`,
  listUsers: () => req<User[]>('/users'),
  createUser: (username: string, password: string) => req<User>('/users', json({ username, password })),
  updateUser: (id: number, patch: UserPatch) => req<User>(`/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteUser: (id: number) => req<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  activity: (opts?: { limit?: number; type?: string }) => req<ActivityEvent[]>(`/activity?${new URLSearchParams({ ...(opts?.limit ? { limit: String(opts.limit) } : {}), ...(opts?.type ? { type: opts.type } : {}) }).toString()}`),
  projects: () => req<Project[]>('/projects'),
  createProject: (v: { slug: string; path: string; notes?: string }) => req<Project>('/projects', json(v)),
  updateProject: (id: number, patch: { path?: string; notes?: string }) => req<Project>(`/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  projectGit: (id: number) => req<ProjectGit>(`/projects/${id}/git`),
  projectFiles: (id: number) => req<FileNode[]>(`/projects/${id}/files`),
  projectFile: (id: number, path: string) => req<{ content: string; truncated: boolean }>(`/projects/${id}/file?path=${encodeURIComponent(path)}`),
  writeProjectFile: (id: number, path: string, content: string) => req<{ ok: boolean }>(`/projects/${id}/file`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) }),
  projectFileAtHead: (id: number, path: string) => req<{ content: string }>(`/projects/${id}/head?path=${encodeURIComponent(path)}`),
  projectCommit: (id: number, hash: string) => req<{ diff: string; files: string[] }>(`/projects/${id}/commit/${encodeURIComponent(hash)}`),
  projectCommitFileDiff: (id: number, hash: string, path: string) => req<{ diff: string }>(`/projects/${id}/commit/${encodeURIComponent(hash)}/diff?path=${encodeURIComponent(path)}`),
  // Authenticated URL for raw file bytes (image previews) — usable directly as an <img> src since
  // the daemon also accepts the token as a query param.
  projectRawUrl: (id: number, path: string) => `${BASE}/projects/${id}/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(getToken() ?? '')}`,
  newProjectFile: (id: number, path: string) => req<{ ok: boolean }>(`/projects/${id}/new-file`, json({ path })),
  newProjectDir: (id: number, path: string) => req<{ ok: boolean }>(`/projects/${id}/dir`, json({ path })),
  renameProjectEntry: (id: number, from: string, to: string) => req<{ ok: boolean }>(`/projects/${id}/rename`, json({ from, to })),
  copyProjectEntry: (id: number, from: string, to: string) => req<{ ok: boolean }>(`/projects/${id}/copy`, json({ from, to })),
  deleteProjectEntry: (id: number, path: string) => req<{ ok: boolean }>(`/projects/${id}/entry?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  projectChanged: (id: number) => req<{ changed: string[] }>(`/projects/${id}/changed`),
  projectChanges: (id: number) => req<{ diff: string }>(`/projects/${id}/changes`),
  userProjects: (userId: number) => req<number[]>(`/users/${userId}/projects`),
  assignProject: (userId: number, projectId: number) => req<{ ok: boolean }>(`/users/${userId}/projects`, json({ projectId })),
  unassignProject: (userId: number, projectId: number) => req<{ ok: boolean }>(`/users/${userId}/projects/${projectId}`, { method: 'DELETE' }),
  hermesStatus: (home?: string) => req<HermesStatus>(`/integrations/hermes/status${home ? `?home=${encodeURIComponent(home)}` : ''}`),
  hermesInstall: (input: HermesInstallInput) => req<HermesInstallResult>('/integrations/hermes/install', json(input)),
  cliStatus: () => req<CliDetectionResult>('/integrations/cli-status'),
};
