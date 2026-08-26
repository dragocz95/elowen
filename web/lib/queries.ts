import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { elowenClient } from './elowenClient';
import { useTranslation } from './i18n';
import type { MemoryFilters, SlashCommandDef, ProcessInfo, UsageOriginGroup } from './types';

export const QUERY_KEYS = {
  health: ['health'] as const,
  config: ['config'] as const,
  me: ['me'] as const,
  system: ['system'] as const,
  systemReadiness: ['system-readiness'] as const,
  systemSkills: ['system-skills'] as const,
  usageByModel: ['usage-by-model'] as const,
  usageByDay: ['usage-by-day'] as const,
  usageByOrigin: ['usage-by-origin'] as const,
  memories: ['memories'] as const,
  embeddingSettings: ['embedding-settings'] as const,
  memoryCategories: ['memory-categories'] as const,
  categorizationSettings: ['categorization-settings'] as const,
  brainCommands: ['brain-commands'] as const,
  brainRateLimits: ['brain-rate-limits'] as const,
  brainContextUsage: ['brain-context-usage'] as const,
  brainDebugSessions: ['brain-debug-sessions'] as const,
  brainDebugRequests: ['brain-debug-requests'] as const,
  brainDebugRequest: ['brain-debug-request'] as const,
  pluginUi: ['plugin-ui'] as const,
};

/** The published slash-command menu for the web surface — the single source of truth is the daemon's
 *  live plugin registry (GET /brain/commands). Held in the query cache (not a one-shot fetch) so a plugin
 *  toggle / config change / install can invalidate it and the menu re-pulls, instead of showing a stale
 *  snapshot captured when the chat first mounted. Empty when the brain is unwired. */
export const useBrainCommands = () =>
  useQuery<SlashCommandDef[]>({
    queryKey: QUERY_KEYS.brainCommands,
    queryFn: () => elowenClient.brainCommands().then((r) => r.commands),
    staleTime: 60_000,
  });

/** Background processes for the panel next to the todos. Polls quickly while any is running (to catch
 *  exits), slowly otherwise (to catch a newly-spawned one) — the SSE `card` handler also invalidates this
 *  key on spawn/kill for an instant update. */
export const useBrainProcesses = () =>
  useQuery<ProcessInfo[]>({
    queryKey: ['brain-processes'],
    queryFn: elowenClient.brainProcesses,
    refetchInterval: (q) => (q.state.data?.some((p) => p.running) ? 2500 : 10000),
    staleTime: 1000,
  });

/** Total token/cost usage aggregated per model, for the stats page and the dashboard's monthly usage
 *  card. Cost/tokens move slowly. `window` (finite bounds only go into the key — an open `±Infinity`
 *  bound collapses to `null` so every rolling/all-time preset shares one cache entry). */
export const useModelUsage = (window?: { fromMs: number; toMs: number }) =>
  useQuery({
    queryKey: [...QUERY_KEYS.usageByModel,
      Number.isFinite(window?.fromMs) ? window!.fromMs : null,
      Number.isFinite(window?.toMs) ? window!.toMs : null],
    queryFn: () => elowenClient.usageByModel(window),
    refetchInterval: 30_000,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

/** Daily spend over the last `days` days, for the dashboard's spend sparkline. Slow-moving, so a
 *  gentle 60 s poll. Only days with settled tasks come back — the tile pads the missing days. */
export const useUsageByDay = (days = 7) =>
  useQuery({
    queryKey: [...QUERY_KEYS.usageByDay, days],
    queryFn: () => elowenClient.usageByDay(days),
    refetchInterval: 60_000,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

/** ADMIN-ONLY: who spent the tokens, and from which address. `enabled` exists because the route answers
 *  403 to a non-admin BY DESIGN — the caller passes the admin flag it already has so a normal account
 *  never fires a request that is meant to fail. The server decides regardless; this only avoids noise.
 *  Polled gently: the drawer is opened deliberately and the rollup moves at the pace of settled turns. */
export const useUsageByOrigin = (
  group: UsageOriginGroup = 'pair',
  window?: { fromMs: number; toMs: number },
  opts?: { enabled?: boolean; limit?: number },
) =>
  useQuery({
    queryKey: [...QUERY_KEYS.usageByOrigin, group,
      Number.isFinite(window?.fromMs) ? window!.fromMs : null,
      Number.isFinite(window?.toMs) ? window!.toMs : null,
      opts?.limit ?? 50],
    queryFn: () => elowenClient.usageByOrigin(group, window, opts?.limit ?? 50),
    enabled: opts?.enabled !== false,
    refetchInterval: 60_000,
  });

export const useHealth = () =>
  useQuery({
    queryKey: QUERY_KEYS.health,
    queryFn: elowenClient.health,
    refetchInterval: 10000,
  });

export const useConfig = () =>
  useQuery({ queryKey: QUERY_KEYS.config, queryFn: elowenClient.getConfig });

/** Elowen's version + update posture for the System settings panel. Polled so an "update available"
 *  badge appears without a reload, and so the version flips after a manual/auto update + restart. */
export const useSystem = () =>
  useQuery({ queryKey: QUERY_KEYS.system, queryFn: elowenClient.system, refetchInterval: 60000 });

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: elowenClient.listUsers });

/** The presence line of the team feed. Invalidated by the same SSE 'activity' event as the feed
 *  itself, so it moves when someone starts or finishes work rather than on a timer. */
export const usePresence = () =>
  useQuery({ queryKey: ['activity-presence'], queryFn: elowenClient.activityPresence });

/** The team pulse tile. Invalidated by the same SSE 'activity' event as the feed, so somebody starting
 *  a turn lights up their layer without a poll. */
export const usePulse = () =>
  useQuery({ queryKey: ['activity-pulse'], queryFn: elowenClient.activityPulse });

export const useActivity = (type?: string, limit?: number) =>
  // SSE activity events invalidate this key; no polling is needed. `limit` joins
  // the key so a small dashboard tail and the full timeline never share one cached payload.
  useQuery({
    queryKey: ['activity', type ?? 'all', limit ?? null],
    queryFn: () => elowenClient.activity({
      ...(type ? { type } : {}),
      ...(limit ? { limit } : {}),
    }),
  });

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: elowenClient.projects, staleTime: 60_000 });

export const useProjectSummaries = () =>
  useQuery({ queryKey: ['project-summaries'], queryFn: elowenClient.projectSummaries, staleTime: 30_000 });

export const useProjectGit = (id: number | null) =>
  useQuery({ queryKey: ['project-git', id], queryFn: () => elowenClient.projectGit(id as number), enabled: !!id });

export const useProjectUsers = (id: number | null, enabled = true) =>
  useQuery({ queryKey: ['project-users', id], queryFn: () => elowenClient.projectUsers(id as number), enabled: !!id && enabled });

export const useProjectFiles = (id: number | null) =>
  useQuery({ queryKey: ['project-files', id], queryFn: () => elowenClient.projectFiles(id as number), enabled: !!id });

export const useProjectFile = (id: number | null, path: string | null) =>
  useQuery({ queryKey: ['project-file', id, path], queryFn: () => elowenClient.projectFile(id as number, path as string), enabled: !!id && !!path });

export const useProjectCommit = (id: number | null, hash: string | null) =>
  useQuery({ queryKey: ['project-commit', id, hash], queryFn: () => elowenClient.projectCommit(id as number, hash as string), enabled: !!id && !!hash });

export const useProjectFileAtHead = (id: number | null, path: string | null, enabled: boolean) =>
  useQuery({ queryKey: ['project-head', id, path], queryFn: () => elowenClient.projectFileAtHead(id as number, path as string), enabled: !!id && !!path && enabled });

export const useProjectCommitFileDiff = (id: number | null, hash: string | null, path: string | null) =>
  useQuery({ queryKey: ['project-commit-file', id, hash, path], queryFn: () => elowenClient.projectCommitFileDiff(id as number, hash as string, path as string), enabled: !!id && !!hash && !!path });

export const useProjectChanged = (id: number | null, enabled = true) =>
  useQuery({ queryKey: ['project-changed', id], queryFn: () => elowenClient.projectChanged(id as number), enabled: !!id && enabled });

export const useProjectChanges = (id: number | null, enabled: boolean) =>
  useQuery({ queryKey: ['project-changes', id], queryFn: () => elowenClient.projectChanges(id as number), enabled: !!id && enabled });

export const useMe = () =>
  useQuery({ queryKey: QUERY_KEYS.me, queryFn: elowenClient.me, staleTime: 5 * 60 * 1000 });

/** Enabled plugins with a browser UI — drives the shell nav + the /p/[plugin] host page. Keyed per
 *  locale (labels are localized server-side); held in the query cache so a plugin toggle can invalidate
 *  it and the menu updates without a reload. The root layout seeds the first-paint locale's listing
 *  into this cache; `placeholderData` keeps that previous listing across the post-mount locale switch,
 *  so stored-locale users don't lose the plugin worlds (and the layout) while their locale's loads. */
export const usePluginUi = (locale: string) =>
  useQuery({
    queryKey: [...QUERY_KEYS.pluginUi, locale],
    queryFn: () => elowenClient.pluginUi(locale),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

/** Whether a named plugin contributes a browser UI on this instance — read from the SAME /plugins/ui
 *  listing the sidebar nav uses, so every affordance a plugin owns gates on one source. False while the
 *  listing loads: a plugin's affordances appear only once it is confirmed, so a plugin-less instance
 *  never flashes them. */
export const usePluginPresent = (name: string): boolean => {
  const { locale } = useTranslation();
  const pluginUi = usePluginUi(locale);
  return (pluginUi.data ?? []).some((p) => p.name === name);
};

/** First-run subsystem readiness (admin-only endpoint). Gated by `enabled` so non-admin surfaces never
 *  fire the 403 request. Powers the dashboard "finish setup" nudge and the onboarding checklist. */
export const useSystemReadiness = (enabled = true) =>
  useQuery({ queryKey: QUERY_KEYS.systemReadiness, queryFn: elowenClient.systemReadiness, staleTime: 60_000, enabled });

/** The current user's CLI/brain settings (model override + auto-compact). Edited in Account → CLI. */
export const useMyCliSettings = () =>
  useQuery({ queryKey: ['my-cli-settings'], queryFn: elowenClient.myCliSettings });

/** The current user's web-terminal appearance settings (palette/font/cursor). Edited in Account →
 *  Terminal; consumed by every xterm instance via useTerminalPrefs. */
export const useMyTerminalSettings = () =>
  useQuery({ queryKey: ['my-terminal-settings'], queryFn: elowenClient.myTerminalSettings, staleTime: 5 * 60 * 1000 });

/** The current user's granular tool permissions (rules + persisted YOLO default). Edited in Account →
 *  Elowen AI (the YOLO toggle) and grown by the approval prompt's "Always allow" flow. */
export const useMyPermissions = () =>
  useQuery({ queryKey: ['my-permissions'], queryFn: elowenClient.myPermissions });

/** The current user's navigation layout (hidden worlds + their order). Read by the shell on every render,
 *  so it is cached like the rest of the chrome and refreshed only when the user edits the menu. */
export const useMyNavSettings = () =>
  useQuery({ queryKey: ['my-nav-settings'], queryFn: elowenClient.myNavSettings, staleTime: 5 * 60 * 1000 });

/** Installed daemon plugins (admin). Toggling invalidates ['plugins']. */
export const usePlugins = () =>
  useQuery({ queryKey: ['plugins'], queryFn: elowenClient.plugins, staleTime: 60_000 });

/** One plugin's settings detail (schema + values, secrets masked). */
export const usePluginDetail = (name: string | null) =>
  useQuery({ queryKey: ['plugin', name], queryFn: () => elowenClient.pluginDetail(name as string), enabled: !!name });

/** Runtime contributions owned by one plugin (tools/skills/platforms/hooks/…). Powers Tools + Hooks detail. */
export const usePluginContributions = (name: string | null) =>
  useQuery({ queryKey: ['plugin-contributions', name], queryFn: () => elowenClient.pluginContributions(name as string), enabled: !!name });

/** The tail of one plugin's log ring buffer plus derived health (the Logs detail section). Polled every
 *  3 s while a detail is open so logs + the health badge stay live without a manual refresh; the query is
 *  disabled (and polling stops) as soon as the detail closes. */
export const usePluginLogs = (name: string | null) =>
  useQuery({ queryKey: ['plugin-logs', name], queryFn: () => elowenClient.pluginLogs(name as string), enabled: !!name, refetchInterval: name ? 3000 : false });

/** How often the open log viewer re-pulls the file list and the selected file's tail, so new entries
 *  appear without a manual refresh. A few seconds keeps it live without hammering the daemon; polling
 *  only runs while the modal (and thus these observers) is mounted with `poll` set. */
const LOG_POLL_MS = 3000;

/** The daily log files on disk (Settings → Data → Logs). `poll` is set only by the open log viewer so
 *  a new day's file / changing sizes stay current; the Data-tab summary reads it without polling, and a
 *  day roll-over or a delete already invalidates it. */
export const useLogFiles = (enabled = true, poll = false) =>
  useQuery({ queryKey: ['log-files'], queryFn: () => elowenClient.logFiles(), enabled, refetchInterval: poll ? LOG_POLL_MS : false });

/** A bounded tail of one log file. `lines` is part of the key so asking for the whole file after a
 *  truncated read fetches instead of serving the short cached copy. `poll` keeps the tail live in the
 *  open viewer — it is left off for a full-file read so polling never re-pulls a large payload. */
export const useLogFile = (name: string | null, lines?: number, poll = false) =>
  useQuery({
    queryKey: ['log-file', name, lines ?? null],
    queryFn: () => elowenClient.logFile(name as string, lines),
    enabled: !!name,
    // Stop the poll once the read has errored: a file deleted from under the viewer (404) would otherwise
    // 404 every few seconds forever. The healthy tail keeps its interval; the error state's manual retry
    // clears the error and resumes polling.
    refetchInterval: poll ? (q) => (q.state.status === 'error' ? false : LOG_POLL_MS) : false,
  });

/** One plugin's hook-run audit, newest-first (the Hooks section's recent-executions panel). */
export const usePluginHookExecutions = (name: string | null) =>
  useQuery({ queryKey: ['plugin-hook-executions', name], queryFn: () => elowenClient.pluginHookExecutions(name as string), enabled: !!name });

/** The plugin marketplace catalog — the curated registry cross-referenced with what's on disk (admin). */
export const useMarketplace = () =>
  useQuery({ queryKey: ['marketplace'], queryFn: () => elowenClient.marketplace() });

/** The cronjob plugin's scheduled jobs (admin-only endpoint). `enabled` lets non-admin surfaces (the
 *  dashboard cron tile) skip the fetch entirely so it doesn't 403 in the console. */
export const useCronJobs = (enabled = true) =>
  useQuery({ queryKey: ['cron-jobs'], queryFn: elowenClient.cronJobs, enabled });

export const useSessionTasks = (sessionId: string | null) =>
  useQuery({
    queryKey: ['session-tasks', sessionId],
    queryFn: () => elowenClient.sessionTasks(sessionId as string),
    enabled: !!sessionId,
  });

/** The skills plugin's markdown skills — bundled + user (admin, the skills plugin detail). */
export const usePluginSkills = () =>
  useQuery({ queryKey: ['plugin-skills'], queryFn: elowenClient.pluginSkills });

/** The subagent plugin's typed sub-agents — built-in + user (admin, the subagent plugin detail). */
export const usePluginSubagents = () =>
  useQuery({ queryKey: ['plugin-subagents'], queryFn: elowenClient.pluginSubagents });

/** Admin-selectable proactive-notification targets across every enabled platform plugin. */
export const useNotificationDestinations = () =>
  useQuery({ queryKey: ['notification-destinations'], queryFn: elowenClient.notificationDestinations, staleTime: 60_000 });

/** Admin-selectable tools from the live built-in + enabled-plugin registry. */
export const usePluginTools = () =>
  useQuery({ queryKey: ['plugin-tools'], queryFn: elowenClient.pluginTools, staleTime: 60_000 });

/** Admin request diagnostics. List queries carry metadata only; segment and raw payloads are separate lazy reads. */
export const useBrainDebugSessions = (filters: Record<string, string | number | undefined>, enabled = true) =>
  useInfiniteQuery({
    queryKey: [...QUERY_KEYS.brainDebugSessions, filters],
    queryFn: ({ pageParam }) => elowenClient.brainDebugSessions({ ...filters, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });

export const useBrainDebugRequests = (sessionId: string | null) =>
  useInfiniteQuery({
    queryKey: [...QUERY_KEYS.brainDebugRequests, sessionId],
    queryFn: ({ pageParam }) => elowenClient.brainDebugRequests(sessionId as string, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!sessionId,
  });

export const useBrainDebugRequest = (sessionId: string | null, requestId: string | null) =>
  useQuery({
    queryKey: [...QUERY_KEYS.brainDebugRequest, sessionId, requestId],
    queryFn: () => elowenClient.brainDebugRequest(sessionId as string, requestId as string),
    enabled: !!sessionId && !!requestId,
  });

export const useBrainDebugSegment = (sessionId: string | null, requestId: string | null, index: number | null) =>
  useQuery({
    queryKey: ['brain-debug-segment', sessionId, requestId, index],
    queryFn: () => elowenClient.brainDebugSegment(sessionId as string, requestId as string, index as number),
    enabled: !!sessionId && !!requestId && index !== null,
  });

export const useBrainDebugRaw = (sessionId: string | null, requestId: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ['brain-debug-raw', sessionId, requestId],
    queryFn: () => elowenClient.brainDebugRaw(sessionId as string, requestId as string),
    enabled: enabled && !!sessionId && !!requestId,
  });

export const useBrainDebugLegacy = (sessionId: string | null, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: ['brain-debug-legacy', sessionId],
    queryFn: ({ pageParam }) => elowenClient.brainDebugLegacy(sessionId as string, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && !!sessionId,
  });

/** The caller's brain conversations (web chat session picker). */
export const useBrainSessions = () =>
  useQuery({ queryKey: ['brain-sessions'], queryFn: elowenClient.brainSessions });

/** Pickable brain models across all configured providers (the Account → CLI dropdown source). */
export const useBrainModels = () =>
  useQuery({ queryKey: ['brain-models'], queryFn: elowenClient.brainModels, staleTime: 60_000 });

/** Which brain OAuth accounts are connected (admin, Settings → Brain). */
export const useBrainOauthStatus = () =>
  useQuery({ queryKey: ['brain-oauth'], queryFn: elowenClient.brainOauthStatus });

/** Subscription usage per connected OAuth account (Settings → Brain). The daemon caches upstream for ~60s,
 *  so polling more often is cheap (served from that cache) but keeps the bars live without a manual reload:
 *  refresh every 20s, on window focus, and on remount. */
export const useBrainRateLimitsAll = () =>
  useQuery({
    queryKey: QUERY_KEYS.brainRateLimits,
    queryFn: elowenClient.brainRateLimitsAll,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    staleTime: 0,
  });

/** What is filling the chat's context window, for the Usage modal's Context section. Fetched only while
 *  that section is on screen (`enabled`) — it walks the live transcript, so there is no reason to poll it
 *  from a closed modal. Keyed by conversation so switching chats cannot show the previous one's figures. */
export const useBrainContextUsage = (session: string | null, enabled = true) =>
  useQuery({
    queryKey: [...QUERY_KEYS.brainContextUsage, session],
    queryFn: () => elowenClient.brainContextUsage(session ?? undefined),
    enabled,
    refetchInterval: 15_000,
  });

/** The chat's own status row, for the `/reasoning` picker: which effort levels the CURRENT model offers,
 *  their labels and the one in force. Fetched only while that modal is open — the controller's own status
 *  poll is about usage and does not carry them into React state. Keyed by conversation. */
export const useBrainSessionStatus = (session: string | null, enabled = true) =>
  useQuery({
    queryKey: ['brain-session-status', session],
    queryFn: () => elowenClient.brainStatus(session ?? undefined),
    enabled,
    staleTime: 0,
  });

export const useUserProjects = (userId: number | null, enabled = true) =>
  useQuery({ queryKey: ['user-projects', userId], queryFn: () => elowenClient.userProjects(userId as number), enabled: !!userId && enabled });

/** Admin: the effective tool access + per-user overview stats for the users-panel detail. Keyed by
 *  user id and only fetched when a user is selected (and the viewer is an admin). */
export const useUserTools = (userId: number | null, enabled = true) =>
  useQuery({ queryKey: ['user-tools', userId], queryFn: () => elowenClient.userTools(userId as number), enabled: !!userId && enabled });

export const useUserStats = (userId: number | null, enabled = true) =>
  useQuery({ queryKey: ['user-stats', userId], queryFn: () => elowenClient.userStats(userId as number), enabled: !!userId && enabled });

/** The caller's own memories, filtered by status/kind/search. Private per-user — identity is server-side.
 *  Mutations invalidate the ['memories'] prefix, so every filter view refreshes together. */
export const useMemories = (filters?: MemoryFilters) =>
  useQuery({ queryKey: ['memories', filters ?? {}], queryFn: () => elowenClient.memories(filters) });

/** One memory (any status) for the detail pane. Disabled until an id is selected. */
export const useMemory = (id: number | null) =>
  useQuery({ queryKey: ['memory', id], queryFn: () => elowenClient.memory(id as number), enabled: id != null });

/** A memory's audit trail (`id` set) or the whole-user event feed (`id` null). Always enabled — a null
 *  id is the valid "everything" feed, not an unselected state. */
export const useMemoryEvents = (id: number | null) =>
  useQuery({ queryKey: ['memory-events', id], queryFn: () => elowenClient.memoryEvents(id ?? undefined) });

/** One memory's vitality curve for the detail drawer. Disabled until a memory is selected, like
 *  {@link useMemory}. */
export const useMemoryVitalityHistory = (id: number | null) =>
  useQuery({
    queryKey: ['memory-vitality', id],
    queryFn: () => elowenClient.memoryVitalityHistory(id as number),
    enabled: id != null,
  });

/** Workspace embedding provider settings (Memory → embedding section). Mutations invalidate this key. */
export const useEmbeddingSettings = () =>
  useQuery({ queryKey: QUERY_KEYS.embeddingSettings, queryFn: elowenClient.embeddingSettings });

/** The caller's own memory categories. Category/reclassify mutations invalidate this key. */
export const useMemoryCategories = () =>
  useQuery({ queryKey: QUERY_KEYS.memoryCategories, queryFn: elowenClient.memoryCategories });

/** Workspace categorization provider settings (Memory → categorization section). Mutations invalidate this key. */
export const useCategorizationSettings = () =>
  useQuery({ queryKey: QUERY_KEYS.categorizationSettings, queryFn: elowenClient.categorizationSettings });

