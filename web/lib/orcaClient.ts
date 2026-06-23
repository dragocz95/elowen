import type { Task, Mission, CreateTaskInput, UpdateTaskInput, PlanInput, PlanSubmitResult, PlanJob, InsertPhasesInput, InsertPhasesResult, EngageInput, OrcaConfig, ConfigPatch, MissionDetail, User, UserPatch, ProfilePatch, AuthResult, ActivityEvent, Project, ProjectGit, CommitLogEntry, HermesStatus, HermesInstallInput, HermesInstallResult, CliDetectionResult, TokenUsage, FileNode, SessionInfo } from './types';
import { clearToken } from './token';

// Same-origin BFF base: the browser talks only to this web origin's /api proxy, which injects the
// daemon bearer token server-side from the httpOnly session cookie. No token ever lives in JS.
export const BASE = '/api';

/** Same-origin WebSocket URL for the terminal PTY stream. The browser opens it straight at nginx's
 *  `/ws/` location (proxied to the daemon), carrying only the single-use ticket — never the token. */
export function terminalWsUrl(ticket: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/terminal?ticket=${encodeURIComponent(ticket)}`;
}

export class OrcaApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'OrcaApiError'; }
}

/** A presentable message for a caught error: prefer the server-provided error code (a short
 *  human-readable string from the daemon) over the raw `orca <status> on <path>` diagnostic, so
 *  toasts show "forbidden" rather than "Error: orca 403 on /tasks". */
export function apiErrorMessage(e: unknown): string {
  if (e instanceof OrcaApiError) return e.code ?? e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // The httpOnly session cookie rides along automatically with same-origin credentials; the proxy
  // turns it into the daemon bearer. No Authorization header is set here on purpose.
  const res = await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' });
  if (res.status === 401) { clearToken(); throw new OrcaApiError(`orca 401 on ${path}`, 401); }
  if (!res.ok) {
    let code: string | undefined;
    try { code = ((await res.json()) as { error?: string }).error; } catch { /* non-JSON body */ }
    throw new OrcaApiError(`orca ${res.status} on ${path}`, res.status, code);
  }
  // 204 No Content (and other empty 2xx bodies) have nothing to parse — callers of such routes
  // type the result as void/unknown, so returning undefined is correct and avoids a SyntaxError.
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx with a non-JSON body (HTML error page from a proxy, truncated stream) — surface a
    // typed error instead of letting an opaque SyntaxError bubble into react-query.
    throw new OrcaApiError(`non-JSON response from ${path}`, res.status);
  }
}

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const orcaClient = {
  tasks: (projectId?: number) => req<Task[]>(projectId != null ? `/tasks?project_id=${projectId}` : '/tasks'),
  ready: () => req<Task[]>('/tasks/ready'),
  sessions: () => req<SessionInfo[]>('/sessions'),
  missions: () => req<Mission[]>('/missions'),
  getMissionDetail: (id: string) => req<MissionDetail>(`/missions/${encodeURIComponent(id)}`),
  health: () => req<{ ok: boolean; version?: string }>('/health'),
  setupStatus: () => req<{ needsSetup: boolean }>('/setup'),
  createTask: (input: CreateTaskInput) => req<Task>('/tasks', json(input)),
  updateTask: (id: string, patch: UpdateTaskInput) => req<Task>(`/tasks/${encodeURIComponent(id)}`, json(patch, 'PATCH')),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Remove a whole mission: the epic, its child tasks and the mission row (not just one task). */
  deleteMission: (epicId: string) => req<{ ok: boolean; tasks: number }>(`/tasks/${encodeURIComponent(epicId)}?subtree=1`, { method: 'DELETE' }),
  /** Admin cleanup: wipe all tasks, missions and the activity feed; stop every live session. */
  cleanupAll: () => req<{ ok: boolean; tasks: number; missions: number; events: number }>('/admin/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  taskDeps: (id: string) => req<string[]>(`/tasks/${encodeURIComponent(id)}/deps`),
  taskUsage: (id: string) => req<TokenUsage | null>(`/tasks/${encodeURIComponent(id)}/usage`),
  allDeps: () => req<{ task_id: string; depends_on_id: string }[]>('/tasks/deps'),
  planTask: (input: PlanInput) => req<PlanSubmitResult>('/tasks/plan', json(input)),
  planPreview: (input: { goal: string; prompt?: string }) => req<{ jobId: string }>('/tasks/plan', json({ ...input, dryRun: true })),
  getPlanJob: (jobId: string) => req<PlanJob>(`/plan/${encodeURIComponent(jobId)}`),
  insertPhases: (epicId: string, input: InsertPhasesInput) => req<InsertPhasesResult>(`/tasks/${encodeURIComponent(epicId)}/phases`, json(input)),
  engage: (input: EngageInput) => req<Mission>('/missions', json(input)),
  spawn: (input: { taskId: string; exec?: string }) => req<{ session: string }>('/sessions', json(input)),
  closeTask: (id: string) => req<Task>(`/tasks/${id}`, json({ status: 'closed' }, 'PATCH')),
  setTaskStatus: (id: string, status: string) => req<Task>(`/tasks/${id}`, json({ status }, 'PATCH')),
  setTaskExec: (id: string, exec: string) => req<Task>(`/tasks/${id}`, json({ exec }, 'PATCH')),
  approveGate: (id: string) => req<{ released: string[] }>(`/tasks/${id}/approve-gate`, { method: 'POST' }),
  sessionPane: (name: string, ansi = false) => req<{ pane: string }>(`/sessions/${encodeURIComponent(name)}/pane${ansi ? '?ansi=1' : ''}`),
  killSession: (name: string) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  sendKeys: (name: string, keys: string[]) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/keys`, json({ keys })),
  resizeSession: (name: string, cols: number, rows: number) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/resize`, json({ cols, rows })),
  /** Forward raw xterm `onData` bytes to a session's pane (snapshot-mirror interactive terminal). */
  sessionInput: (name: string, data: string) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/input`, json({ data })),
  /** Mint a single-use ticket to open the terminal WebSocket stream for a session (PTY stream). */
  wsTicket: (name: string) => req<{ ticket: string }>(`/sessions/${encodeURIComponent(name)}/ws-ticket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  advisorStatus: () => req<{ running: boolean; exec: string; session: string | null }>('/advisor/status'),
  advisorStart: (exec: string) => req<{ session: string }>('/advisor/start', json({ exec })),
  advisorStop: () => req<{ ok: boolean }>('/advisor/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  pauseMission: (id: string) => req<Mission>(`/missions/${id}`, json({ action: 'pause' }, 'PATCH')),
  resumeMission: (id: string) => req<Mission>(`/missions/${id}`, json({ action: 'resume' }, 'PATCH')),
  disengageMission: (id: string) => req<{ ok: boolean }>(`/missions/${id}`, { method: 'DELETE' }),
  getConfig: () => req<OrcaConfig>('/config'),
  updateConfig: (patch: ConfigPatch) => req<OrcaConfig>('/config', json(patch, 'PUT')),
  login: (username: string, password: string) => req<AuthResult>('/auth/login', json({ username, password })),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => req<{ user: User }>('/auth/me'),
  updateMe: (patch: ProfilePatch) => req<User>('/auth/me', json(patch, 'PATCH')),
  uploadAvatar: (file: File) => { const fd = new FormData(); fd.append('avatar', file); return req<User>('/auth/me/avatar', { method: 'POST', body: fd }); },
  changePassword: (currentPassword: string, newPassword: string) => req<{ ok: boolean }>('/auth/me/password', json({ currentPassword, newPassword })),
  // Mint a short-lived signed avatar URL. An <img> can't set an Authorization header, so instead of
  // leaking the long-lived session token into the query string (finding W2) we ask the daemon — over
  // an authenticated request — for an HMAC-signed link that expires in minutes.
  avatarUrl: async (id: number) => `${BASE}${(await req<{ url: string }>(`/users/${id}/avatar/url`)).url}`,
  listUsers: () => req<User[]>('/users'),
  createUser: (username: string, password: string) => req<User>('/users', json({ username, password })),
  updateUser: (id: number, patch: UserPatch) => req<User>(`/users/${id}`, json(patch, 'PATCH')),
  deleteUser: (id: number) => req<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  activity: (opts?: { limit?: number; type?: string }) => {
    const qs = new URLSearchParams({ ...(opts?.limit ? { limit: String(opts.limit) } : {}), ...(opts?.type ? { type: opts.type } : {}) }).toString();
    return req<ActivityEvent[]>(`/activity${qs ? `?${qs}` : ''}`);
  },
  projects: () => req<Project[]>('/projects'),
  createProject: (v: { slug: string; path: string; notes?: string }) => req<Project>('/projects', json(v)),
  updateProject: (id: number, patch: { path?: string; notes?: string; icon?: string }) => req<Project>(`/projects/${id}`, json(patch, 'PATCH')),
  removeProject: (id: number) => req<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  projectGit: (id: number) => req<ProjectGit>(`/projects/${id}/git`),
  projectFiles: (id: number) => req<FileNode[]>(`/projects/${id}/files`),
  projectFile: (id: number, path: string) => req<{ content: string; truncated: boolean }>(`/projects/${id}/file?path=${encodeURIComponent(path)}`),
  writeProjectFile: (id: number, path: string, content: string) => req<{ ok: boolean }>(`/projects/${id}/file`, json({ path, content }, 'PUT')),
  projectFileAtHead: (id: number, path: string) => req<{ content: string }>(`/projects/${id}/head?path=${encodeURIComponent(path)}`),
  projectCommit: (id: number, hash: string) => req<{ diff: string; files: string[] }>(`/projects/${id}/commit/${encodeURIComponent(hash)}`),
  projectCommitFileDiff: (id: number, hash: string, path: string) => req<{ diff: string }>(`/projects/${id}/commit/${encodeURIComponent(hash)}/diff?path=${encodeURIComponent(path)}`),
  // Authenticated fetch of raw file bytes (image previews) as a Blob. Goes through the same-origin
  // /api proxy with the httpOnly session cookie (credentials) — the daemon bearer is injected
  // server-side, never exposed to JS. The caller wraps the Blob in a short-lived object URL for <img src>.
  projectRawBlob: async (id: number, path: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/projects/${id}/raw?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new OrcaApiError(`orca ${res.status} on raw ${path}`, res.status);
    return res.blob();
  },
  newProjectFile: (id: number, path: string) => req<{ ok: boolean }>(`/projects/${id}/new-file`, json({ path })),
  newProjectDir: (id: number, path: string) => req<{ ok: boolean }>(`/projects/${id}/dir`, json({ path })),
  renameProjectEntry: (id: number, from: string, to: string) => req<{ ok: boolean }>(`/projects/${id}/rename`, json({ from, to })),
  copyProjectEntry: (id: number, from: string, to: string) => req<{ ok: boolean }>(`/projects/${id}/copy`, json({ from, to })),
  deleteProjectEntry: (id: number, path: string) => req<{ ok: boolean }>(`/projects/${id}/entry?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  projectCommits: (id: number, limit = 30) => req<{ commits: CommitLogEntry[] }>(`/projects/${id}/commits?limit=${limit}`),
  projectChanged: (id: number) => req<{ changed: string[] }>(`/projects/${id}/changed`),
  projectChanges: (id: number) => req<{ diff: string }>(`/projects/${id}/changes`),
  userProjects: (userId: number) => req<number[]>(`/users/${userId}/projects`),
  assignProject: (userId: number, projectId: number) => req<{ ok: boolean }>(`/users/${userId}/projects`, json({ projectId })),
  unassignProject: (userId: number, projectId: number) => req<{ ok: boolean }>(`/users/${userId}/projects/${projectId}`, { method: 'DELETE' }),
  hermesStatus: (home?: string) => req<HermesStatus>(`/integrations/hermes/status${home ? `?home=${encodeURIComponent(home)}` : ''}`),
  hermesInstall: (input: HermesInstallInput) => req<HermesInstallResult>('/integrations/hermes/install', json(input)),
  cliStatus: () => req<CliDetectionResult>('/integrations/cli-status'),
};
