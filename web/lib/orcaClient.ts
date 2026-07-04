import type { Task, Mission, CreateTaskInput, UpdateTaskInput, PlanInput, PlanSubmitResult, PlanJob, InsertPhasesInput, InsertPhasesResult, EngageInput, OrcaConfig, ConfigPatch, MissionDetail, User, UserPatch, ProfilePatch, UserPrompt, PersonalityProfile, PersonalityCreate, PersonalityPatch, CliSettings, PluginInfo, PluginDetail, PluginContributions, PluginLogs, PluginHookExecutions, CronJob, DiscordChannelOption, PluginSkill, BrainModelOption, BrainSessionInfo, BrainSearchHit, BrainMessage, BrainStatus, OAuthFlowState, AuthResult, ActivityEvent, PendingAsk, Project, ProjectGit, CommitLogEntry, CommitFileChange, Note, CliDetectionResult, GithubAuthStatus, TokenUsage, ModelUsage, ResetUsageResult, FileNode, DirListing, SessionInfo, SystemInfo, SkillsInfo, SkillInstallResult, Memory, MemoryEvent, MemoryCreate, MemoryPatch, MemoryFilters, EmbeddingSettings, EmbeddingSettingsPatch, RetrievalResult, MemoryCategory, MemoryCategoryCreate, MemoryCategoryPatch, CategorizationSettings, CategorizationSettingsPatch } from './types';
import { clearToken } from './token';

// Same-origin BFF base: the browser talks only to this web origin's /api proxy, which injects the
// daemon bearer token server-side from the httpOnly session cookie. No token ever lives in JS.
export const BASE = '/api';

/** WebSocket URL for the terminal PTY stream, carrying only the single-use ticket (never the token).
 *  Behind a proxy / on localhost it's same-origin — nginx's `/ws/` location (or the local daemon)
 *  bridges it. In proxy-less IP mode there's no `/ws/` hop, so `directPort` (the daemon's public port,
 *  surfaced by `/api/ws-config`) targets the daemon straight: `ws://<host>:<port>/ws/terminal`. */
export function terminalWsUrl(ticket: string, directPort?: number | null): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = directPort ? `${location.hostname}:${directPort}` : location.host;
  return `${proto}//${host}/ws/terminal?ticket=${encodeURIComponent(ticket)}`;
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
  /** Files changed across all of a mission's phases, aggregated (summed per path) and churn-sorted. */
  missionChangedFiles: (id: string) => req<CommitFileChange[]>(`/missions/${encodeURIComponent(id)}/changed-files`),
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
  /** Total token/cost usage aggregated per model; optional project filter and date window. `window`
   *  bounds come from `rangeBounds()` (lib/dateRange.ts) and can be `±Infinity` for an open-ended
   *  preset — an infinite bound is simply omitted rather than serialized as an Invalid Date. */
  usageByModel: (projectId?: number, window?: { fromMs: number; toMs: number }) => {
    const params = new URLSearchParams();
    if (projectId != null) params.set('project_id', String(projectId));
    if (window && Number.isFinite(window.fromMs)) params.set('from', new Date(window.fromMs).toISOString());
    if (window && Number.isFinite(window.toMs)) params.set('to', new Date(window.toMs).toISOString());
    const qs = params.toString();
    return req<ModelUsage[]>(`/usage/by-model${qs ? `?${qs}` : ''}`);
  },
  /** Admin: destructively clear every executor's CLI session store. Refused (409) while agents run. */
  resetUsage: () => req<ResetUsageResult>('/usage/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  allDeps: () => req<{ task_id: string; depends_on_id: string }[]>('/tasks/deps'),
  planTask: (input: PlanInput) => req<PlanSubmitResult>('/tasks/plan', json(input)),
  getPlanJob: (jobId: string) => req<PlanJob>(`/plan/${encodeURIComponent(jobId)}`),
  insertPhases: (epicId: string, input: InsertPhasesInput) => req<InsertPhasesResult>(`/tasks/${encodeURIComponent(epicId)}/phases`, json(input)),
  engage: (input: EngageInput) => req<Mission>('/missions', json(input)),
  spawn: (input: { taskId: string; exec?: string }) => req<{ session: string }>('/sessions', json(input)),
  closeTask: (id: string) => req<Task>(`/tasks/${id}`, json({ status: 'closed' }, 'PATCH')),
  setTaskStatus: (id: string, status: string) => req<Task>(`/tasks/${id}`, json({ status }, 'PATCH')),
  setTaskExec: (id: string, exec: string) => req<Task>(`/tasks/${id}`, json({ exec }, 'PATCH')),
  approveGate: (id: string) => req<{ released: string[] }>(`/tasks/${id}/approve-gate`, { method: 'POST' }),
  /** Every `orca ask` parked on a human (overseer escalated / no overseer), for the Escalations inbox. */
  pendingAsks: () => req<PendingAsk[]>('/asks/pending'),
  /** Answer a worker's escalated question — unblocks the agent waiting on `orca ask`. */
  replyAsk: (taskId: string, askId: string, text: string) => req<{ ok: boolean }>(`/tasks/${encodeURIComponent(taskId)}/ask/${encodeURIComponent(askId)}/reply`, json({ text })),
  sessionPane: (name: string, ansi = false) => req<{ pane: string }>(`/sessions/${encodeURIComponent(name)}/pane${ansi ? '?ansi=1' : ''}`),
  killSession: (name: string) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  sendKeys: (name: string, keys: string[]) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/keys`, json({ keys })),
  resizeSession: (name: string, cols: number, rows: number) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/resize`, json({ cols, rows })),
  /** Forward raw xterm `onData` bytes to a session's pane (snapshot-mirror interactive terminal). */
  sessionInput: (name: string, data: string) => req<{ ok: boolean }>(`/sessions/${encodeURIComponent(name)}/input`, json({ data })),
  /** Mint a single-use ticket to open the terminal WebSocket stream for a session (PTY stream). */
  wsTicket: (name: string) => req<{ ticket: string }>(`/sessions/${encodeURIComponent(name)}/ws-ticket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  // Web-native (not proxied to the daemon): how to reach the terminal WS. `directPort` set ⇒ connect
  // straight to the daemon (proxy-less IP mode); null ⇒ same-origin `/ws/`. Stable per deployment.
  wsConfig: () => req<{ directPort: number | null }>('/ws-config'),
  advisorStatus: () => req<{ running: boolean; exec: string; session: string | null; autostart: boolean }>('/advisor/status'),
  advisorStart: (exec: string) => req<{ session: string }>('/advisor/start', json({ exec })),
  advisorStop: () => req<{ ok: boolean }>('/advisor/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  pauseMission: (id: string) => req<Mission>(`/missions/${id}`, json({ action: 'pause' }, 'PATCH')),
  resumeMission: (id: string) => req<Mission>(`/missions/${id}`, json({ action: 'resume' }, 'PATCH')),
  disengageMission: (id: string) => req<{ ok: boolean }>(`/missions/${id}`, { method: 'DELETE' }),
  /** Manually open the PR for a PR-native mission (auto-open off). Returns the PR url + number. */
  openMissionPr: (id: string) => req<{ url: string; number: number }>(`/missions/${id}/pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** Squash-merge a PR-native mission's PR into the base branch. Resolves on success; rejects with the
   *  gate reason (PR not open / conflicts / CI not green) so the UI can show why it was refused. */
  mergeMissionPr: (id: string) => req<{ ok: boolean }>(`/missions/${id}/merge-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  getConfig: () => req<OrcaConfig>('/config'),
  updateConfig: (patch: ConfigPatch) => req<OrcaConfig>('/config', json(patch, 'PUT')),
  system: () => req<SystemInfo>('/system'),
  systemUpdate: () => req<{ started: boolean }>('/system/update', json({})),
  systemRestart: (target: 'daemon' | 'web') => req<{ ok: boolean }>('/system/restart', json({ target })),
  systemSkills: () => req<SkillsInfo>('/system/skills'),
  installSkills: () => req<SkillInstallResult>('/system/skills/install', json({})),
  login: (username: string, password: string) => req<AuthResult>('/auth/login', json({ username, password })),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => req<{ user: User }>('/auth/me'),
  updateMe: (patch: ProfilePatch) => req<User>('/auth/me', json(patch, 'PATCH')),
  uploadAvatar: (file: File) => { const fd = new FormData(); fd.append('avatar', file); return req<User>('/auth/me/avatar', { method: 'POST', body: fd }); },
  changePassword: (currentPassword: string, newPassword: string) => req<{ ok: boolean }>('/auth/me/password', json({ currentPassword, newPassword })),
  myPrompts: () => req<UserPrompt[]>('/auth/me/prompts'),
  saveMyPrompt: (name: string, content: string) => req<{ ok: boolean }>(`/auth/me/prompts/${encodeURIComponent(name)}`, json({ content }, 'PUT')),
  resetMyPrompt: (name: string) => req<{ ok: boolean }>(`/auth/me/prompts/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  myCliSettings: () => req<CliSettings>('/auth/me/cli-settings'),
  saveMyCliSettings: (patch: Partial<CliSettings>) => req<CliSettings>('/auth/me/cli-settings', json(patch, 'PATCH')),
  /** The caller's own personality profiles, optionally narrowed to one platform. */
  listPersonalities: (platform?: string) => req<PersonalityProfile[]>(`/personality/profiles${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`),
  createPersonality: (body: PersonalityCreate) => req<PersonalityProfile>('/personality/profiles', json(body)),
  updatePersonality: (id: number, patch: PersonalityPatch) => req<PersonalityProfile>(`/personality/profiles/${id}`, json(patch, 'PATCH')),
  deletePersonality: (id: number) => req<{ ok: true }>(`/personality/profiles/${id}`, { method: 'DELETE' }),
  /** Pin a profile active for its own platform; the daemon restarts owner chat + drops channel sessions. */
  activatePersonality: (id: number) => req<PersonalityProfile>(`/personality/profiles/${id}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** The resolved system-prompt stack (core persona + active personality chunk) for one platform. */
  plugins: () => req<PluginInfo[]>('/plugins'),
  togglePlugin: (name: string, enabled: boolean) => req<PluginInfo>(`/plugins/${encodeURIComponent(name)}`, json({ enabled }, 'PATCH')),
  pluginDetail: (name: string) => req<PluginDetail>(`/plugins/${encodeURIComponent(name)}`),
  savePluginConfig: (name: string, values: Record<string, unknown>) => req<{ ok: boolean }>(`/plugins/${encodeURIComponent(name)}/config`, json({ values }, 'PATCH')),
  /** Runtime contributions (tools/skills/platforms/hooks/…) owned by one plugin — powers Tools + Hooks detail. */
  pluginContributions: (name: string) => req<PluginContributions>(`/plugins/${encodeURIComponent(name)}/contributions`),
  /** Tail of one plugin's log ring buffer plus derived health. */
  pluginLogs: (name: string) => req<PluginLogs>(`/plugins/${encodeURIComponent(name)}/logs`),
  /** One plugin's hook-run audit (newest-first) — powers the Hooks section's recent-executions panel. */
  pluginHookExecutions: (name: string) => req<PluginHookExecutions>(`/plugins/${encodeURIComponent(name)}/hook-executions`),
  /** Destructive — wipe the contents of the plugin's data directory (the dir itself is kept). */
  clearPluginData: (name: string) => req<{ ok: true }>(`/plugins/${encodeURIComponent(name)}/data/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** The cronjob plugin's raw jobs list; saving replaces the whole array (applies live, no restart). */
  cronJobs: () => req<CronJob[]>('/plugins/cronjob/jobs'),
  saveCronJobs: (jobs: CronJob[]) => req<{ ok: boolean }>('/plugins/cronjob/jobs', json(jobs, 'PUT')),
  /** The skills plugin's markdown skills (bundled + user); user skills are created/deleted per file. */
  pluginSkills: () => req<PluginSkill[]>('/plugins/skills/list'),
  createPluginSkill: (skill: { name: string; description: string; content: string }) => req<{ ok: boolean }>('/plugins/skills', json(skill)),
  deletePluginSkill: (name: string) => req<{ ok: boolean }>(`/plugins/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** Text channels + active threads of the configured Discord guild (the cron destination picker). */
  discordChannels: () => req<DiscordChannelOption[]>('/plugins/discord/channels'),
  brainModels: () => req<BrainModelOption[]>('/brain/models'),
  taskBrainConversation: (taskId: string) => req<BrainMessage[]>(`/tasks/${encodeURIComponent(taskId)}/conversation`),
  brainStatus: () => req<BrainStatus>('/brain/status'),
  brainStart: (opts: { session?: string; fresh?: boolean } = {}) => req<{ sessionId: string }>('/brain/start', json(opts)),
  brainSend: (text: string, images?: { data: string; mimeType: string }[]) =>
    req<{ ok: boolean }>('/brain/send', json(images?.length ? { text, images } : { text })),
  brainSessions: () => req<BrainSessionInfo[]>('/brain/sessions'),
  brainSearch: (q: string) => req<BrainSearchHit[]>(`/brain/search?q=${encodeURIComponent(q)}`),
  brainDeleteSession: (id: string) => req<{ ok: boolean }>(`/brain/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  brainMessages: () => req<BrainMessage[]>('/brain/messages'),
  brainOauthStatus: () => req<Record<string, boolean>>('/brain/oauth/status'),
  brainOauthCatalog: (type: string) => req<{ models: string[] }>(`/brain/oauth/${encodeURIComponent(type)}/catalog`),
  brainProviderProbe: (body: { baseUrl: string; apiKey?: string; id?: string }) => req<{ models: string[] }>('/brain/providers/probe', { method: 'POST', body: JSON.stringify(body) }),
  brainOauthStart: (type: string) => req<OAuthFlowState>(`/brain/oauth/${encodeURIComponent(type)}/start`, { method: 'POST' }),
  brainOauthFlow: (id: string) => req<OAuthFlowState>(`/brain/oauth/flow/${encodeURIComponent(id)}`),
  brainOauthInput: (id: string, value: string) => req<{ ok: boolean }>(`/brain/oauth/flow/${encodeURIComponent(id)}/input`, json({ value })),
  brainOauthDisconnect: (type: string) => req<{ ok: boolean }>(`/brain/oauth/${encodeURIComponent(type)}`, { method: 'DELETE' }),
  // Mint a short-lived signed avatar URL. An <img> can't set an Authorization header, so instead of
  // leaking the long-lived session token into the query string (finding W2) we ask the daemon — over
  // an authenticated request — for an HMAC-signed link that expires in minutes.
  avatarUrl: async (id: number) => `${BASE}${(await req<{ url: string }>(`/users/${id}/avatar/url`)).url}`,
  listUsers: () => req<User[]>('/users'),
  createUser: (username: string, password: string) => req<User>('/users', json({ username, password })),
  updateUser: (id: number, patch: UserPatch) => req<User>(`/users/${id}`, json(patch, 'PATCH')),
  deleteUser: (id: number) => req<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  activity: (opts?: { limit?: number; type?: string; target?: string }) => {
    const qs = new URLSearchParams({ ...(opts?.limit ? { limit: String(opts.limit) } : {}), ...(opts?.type ? { type: opts.type } : {}), ...(opts?.target ? { target: opts.target } : {}) }).toString();
    return req<ActivityEvent[]>(`/activity${qs ? `?${qs}` : ''}`);
  },
  projects: () => req<Project[]>('/projects'),
  createProject: (v: { slug: string; path: string; notes?: string }) => req<Project>('/projects', json(v)),
  updateProject: (id: number, patch: { path?: string; notes?: string; icon?: string; pr_enabled?: boolean | null }) => req<Project>(`/projects/${id}`, json(patch, 'PATCH')),
  removeProject: (id: number) => req<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  projectGit: (id: number) => req<ProjectGit>(`/projects/${id}/git`),
  projectFiles: (id: number) => req<FileNode[]>(`/projects/${id}/files`),
  /** Browse the server's directory tree to pick a new project's path. Admin-only on the daemon. */
  browseDirs: (path?: string) => req<DirListing>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
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
  taskCommits: (id: string) => req<{ commits: CommitLogEntry[] }>(`/tasks/${encodeURIComponent(id)}/commits`),
  taskCommitFileDiff: (id: string, hash: string, path: string) => req<{ diff: string }>(`/tasks/${encodeURIComponent(id)}/commit/${encodeURIComponent(hash)}/diff?path=${encodeURIComponent(path)}`),
  missionNotes: (target: string) => req<Note[]>(`/notes?scope=mission&target=${encodeURIComponent(target)}`),
  userProjects: (userId: number) => req<number[]>(`/users/${userId}/projects`),
  assignProject: (userId: number, projectId: number) => req<{ ok: boolean }>(`/users/${userId}/projects`, json({ projectId })),
  unassignProject: (userId: number, projectId: number) => req<{ ok: boolean }>(`/users/${userId}/projects/${projectId}`, { method: 'DELETE' }),
  /** The caller's own memories. A non-blank `q` runs fulltext search; otherwise it lists by status
   *  (default 'active'; pass status '' or 'all' for every status). Own only — identity is server-side. */
  memories: (params?: MemoryFilters) => {
    const qs = new URLSearchParams();
    if (params?.status != null) qs.set('status', params.status);
    if (params?.kind) qs.set('kind', params.kind);
    if (params?.q) qs.set('q', params.q);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    // categoryId: key present (even null) filters; null/empty → uncategorized, number → that category.
    if (params && 'categoryId' in params) qs.set('categoryId', params.categoryId == null ? '' : String(params.categoryId));
    const s = qs.toString();
    return req<Memory[]>(`/memory${s ? `?${s}` : ''}`);
  },
  memory: (id: number) => req<Memory>(`/memory/${id}`),
  createMemory: (body: MemoryCreate) => req<Memory>('/memory', json(body)),
  updateMemory: (id: number, patch: MemoryPatch) => req<Memory>(`/memory/${id}`, json(patch, 'PATCH')),
  /** Assign (or clear with null) a memory's category — a separately-audited write, not a PATCH field
   *  (the memory PATCH schema ignores categoryId). Maps to PUT /memory/:id/category → MemoryStore.setCategory. */
  setMemoryCategory: (id: number, categoryId: number | null) => req<Memory>(`/memory/${id}/category`, json({ categoryId }, 'PUT')),
  deleteMemory: (id: number) => req<{ ok: boolean }>(`/memory/${id}`, { method: 'DELETE' }),
  restoreMemory: (id: number) => req<{ ok: boolean }>(`/memory/${id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** Hard-delete many owned memories in one call; returns how many were purged. Irreversible. */
  purgeMemories: (ids: number[]) => req<{ purged: number }>('/memory/purge', json({ ids })),
  /** Hard-delete ALL of the caller's status='deleted' memories (empty trash); returns the count. */
  emptyTrash: () => req<{ purged: number }>('/memory/empty-trash', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  mergeMemories: (ids: number[], body: string) => req<Memory>('/memory/merge', json({ ids, body })),
  /** A single memory's audit trail (`id` set) or the whole-user event feed (`id` omitted). */
  memoryEvents: (id?: number) => req<MemoryEvent[]>(id != null ? `/memory/${id}/events` : '/memory/events'),
  /** Run retrieval for a query and get the picked memories plus the scoring trace. POST because the
   *  daemon marks the picked memories used (a mutation). */
  retrievalDebug: (query: string) => req<RetrievalResult>('/memory/retrieve', json({ query })),
  /** Re-embed the caller's memories that still need an embedding (bounded, best-effort). */
  reindexMemories: () => req<{ embedded: number }>('/memory/reindex', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** The caller's own memory categories (built-in + user-defined). */
  memoryCategories: () => req<MemoryCategory[]>('/memory/categories'),
  createMemoryCategory: (body: MemoryCategoryCreate) => req<MemoryCategory>('/memory/categories', json(body)),
  updateMemoryCategory: (cid: number, patch: MemoryCategoryPatch) => req<MemoryCategory>(`/memory/categories/${cid}`, json(patch, 'PATCH')),
  deleteMemoryCategory: (cid: number) => req<{ ok: boolean }>(`/memory/categories/${cid}`, { method: 'DELETE' }),
  /** Let the model pick a lucide icon (from the shared allowlist) for a category name; fail-soft "Folder". */
  suggestCategoryIcon: (name: string) => req<{ icon: string }>('/memory/categories/suggest-icon', json({ name })),
  /** Workspace-level categorization provider settings. */
  categorizationSettings: () => req<CategorizationSettings>('/memory/categorization'),
  saveCategorizationSettings: (patch: CategorizationSettingsPatch) => req<CategorizationSettings>('/memory/categorization', json(patch, 'PUT')),
  /** Re-run categorization over the caller's memories (owner-scoped, bounded). */
  reclassifyMemories: (body?: { limit?: number; includeCategorized?: boolean }) => req<{ scanned: number; classified: number }>('/memory/reclassify', json(body ?? {})),
  embeddingSettings: () => req<EmbeddingSettings>('/memory/embedding'),
  saveEmbeddingSettings: (patch: EmbeddingSettingsPatch) => req<EmbeddingSettings>('/memory/embedding', json(patch, 'PUT')),
  /** Admin: probe the embedding provider with a tiny sample. An embed failure resolves 200 `{ ok:false }`
   *  (read `ok`); the unconfigured case is a 400 that `req` throws as an OrcaApiError for the caller to catch. */
  testEmbedding: () => req<{ ok: true; dimensions: number; provider: string | null; model: string } | { ok: false; error: string }>('/memory/embedding/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  cliStatus: () => req<CliDetectionResult>('/integrations/cli-status'),
  githubStatus: () => req<GithubAuthStatus>('/integrations/github-status'),
};
