'use client';
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { elowenClient } from './elowenClient';
import { QUERY_KEYS } from './queries';
import type { Task, CreateTaskInput, UpdateTaskInput, PlanInput, EngageInput, ConfigPatch, InsertPhasesInput, UserPatch, ProfilePatch, CliSettings, TerminalSettings, PermissionSettings, CronJob, PersonalityCreate, PersonalityPatch, MemoryCreate, MemoryPatch, EmbeddingSettingsPatch, MemoryCategoryCreate, MemoryCategoryPatch, CategorizationSettingsPatch, PluginInfo, PluginDetail } from './types';

type TaskCacheSnapshot = Array<[QueryKey, Task[] | undefined]>;

/** Apply one task patch to every all/project-scoped task cache. The snapshot is restored on failure,
 * while SSE/invalidation remains the final source of truth after the mutation settles. */
async function optimisticTaskPatch(qc: QueryClient, id: string, patch: Partial<Task>): Promise<TaskCacheSnapshot> {
  await qc.cancelQueries({ queryKey: QUERY_KEYS.tasks });
  const snapshots = qc.getQueriesData<Task[]>({ queryKey: QUERY_KEYS.tasks });
  qc.setQueriesData<Task[]>({ queryKey: QUERY_KEYS.tasks }, (current) => current?.map((task) => task.id === id ? { ...task, ...patch } : task));
  return snapshots;
}

function restoreTaskCaches(qc: QueryClient, snapshots?: TaskCacheSnapshot) {
  for (const [queryKey, value] of snapshots ?? []) qc.setQueryData(queryKey, value);
}

export function useSpawn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; exec?: string }) => elowenClient.spawn(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CreateTaskInput) => elowenClient.createTask(input), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: UpdateTaskInput }) => elowenClient.updateTask(v.id, v.patch),
    onMutate: (v) => optimisticTaskPatch(qc, v.id, v.patch as Partial<Task>),
    onError: (_error, _variables, snapshots) => restoreTaskCaches(qc, snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }),
  });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.deleteTask(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useDeleteMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) => elowenClient.deleteMission(epicId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.missions });
      qc.invalidateQueries({ queryKey: ['mission'] });
    },
  });
}
/** Admin: destructively reset all usage stores. Invalidates the usage query on success. */
export function useResetUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.resetUsage(),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.usageByModel }),
  });
}

export function useCleanupAll() {
  const qc = useQueryClient();
  // cleanupAll disengages every mission, kills the elowen- sessions and wipes tasks + events. Invalidate
  // exactly those caches (+ the mission detail and session signals derived from them) instead of a
  // wildcard `invalidateQueries()` — config/system/users/usage don't change, so refetching them just
  // re-hammers the daemon for no reason.
  return useMutation({
    mutationFn: () => elowenClient.cleanupAll(),
    onSuccess: () => {
      for (const queryKey of [QUERY_KEYS.tasks, QUERY_KEYS.missions, ['mission'], QUERY_KEYS.sessions, QUERY_KEYS.sessionSignals, ['activity']]) {
        qc.invalidateQueries({ queryKey });
      }
    },
  });
}
export function usePlanTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PlanInput) => elowenClient.planTask(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }); },
  });
}
export function useInsertPhases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { epicId: string; body: InsertPhasesInput }) => elowenClient.insertPhases(v.epicId, v.body),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks });
      // Invalidate only the affected epic's mission detail, not every open mission (the broad
      // `['mission']` prefix would refetch all open detail views, including the stray null key).
      qc.invalidateQueries({ queryKey: ['mission', v.epicId] });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.missions });
    },
  });
}
export function useCloseTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.closeTask(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useSetTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: string }) => elowenClient.setTaskStatus(v.id, v.status),
    onMutate: (v) => optimisticTaskPatch(qc, v.id, { status: v.status as Task['status'] }),
    onError: (_error, _variables, snapshots) => restoreTaskCaches(qc, snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }),
  });
}
export function useApproveGate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.approveGate(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useReplyAsk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string; askId: string; text: string }) => elowenClient.replyAsk(v.taskId, v.askId, v.text),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['pending-asks'] }); qc.invalidateQueries({ queryKey: ['task-activity', v.taskId] }); },
  });
}
export function useSetTaskExec() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string; exec: string }) => elowenClient.setTaskExec(v.id, v.exec), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useKillSession() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => elowenClient.killSession(name), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }) });
}
export function useSendInput() {
  return useMutation({ mutationFn: (v: { name: string; keys: string[] }) => elowenClient.sendKeys(v.name, v.keys) });
}
export function useEngage() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: EngageInput) => elowenClient.engage(input), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function usePauseMission() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.pauseMission(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useResumeMission() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.resumeMission(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useDisengage() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.disengageMission(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useOpenMissionPr() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.openMissionPr(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useMergeMissionPr() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.mergeMissionPr(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: ConfigPatch) => elowenClient.updateConfig(patch), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.config }) });
}
/** Trigger a manual in-place update. The daemon restarts mid-flight, so the System panel just re-polls
 *  /system afterwards to pick up the new version. */
export function useSystemUpdate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => elowenClient.systemUpdate(), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.system }) });
}
/** Restart one of the systemd units. No invalidation — a daemon restart drops the API for a few
 *  seconds anyway; the System panel's regular polling picks the service back up on its own. */
export function useSystemRestart() {
  return useMutation({ mutationFn: (target: 'daemon' | 'web') => elowenClient.systemRestart(target) });
}
export function useInstallSkills() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => elowenClient.installSkills(), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.systemSkills }) });
}
export function useLogin() {
  return useMutation({ mutationFn: (v: { username: string; password: string }) => elowenClient.login(v.username, v.password) });
}
export function useLogout() {
  return useMutation({ mutationFn: () => elowenClient.logout() });
}
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { username: string; password: string }) => elowenClient.createUser(v.username, v.password), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => elowenClient.deleteUser(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
}
export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: UserPatch }) => elowenClient.updateUser(v.id, v.patch),
    // Refresh the list and the current identity (an admin could change their own role).
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
}
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: ProfilePatch) => elowenClient.updateMe(patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
}
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (file: File) => elowenClient.uploadAvatar(file), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
}
export function useChangePassword() {
  return useMutation({ mutationFn: (v: { currentPassword: string; newPassword: string }) => elowenClient.changePassword(v.currentPassword, v.newPassword) });
}
export function useSaveMyCliSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: Partial<CliSettings>) => elowenClient.saveMyCliSettings(patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-cli-settings'] }) });
}
export function useSaveMyTerminalSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: Partial<TerminalSettings>) => elowenClient.saveMyTerminalSettings(patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-terminal-settings'] }) });
}
export function useSaveMyPermissions() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: Partial<PermissionSettings>) => elowenClient.saveMyPermissions(patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-permissions'] }) });
}
/** Create a personality profile. Invalidates the profiles list (all platforms). */
export function useCreatePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PersonalityCreate) => elowenClient.createPersonality(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Patch a personality profile. Refresh the profiles list (the server carries the authoritative active flag). */
export function useUpdatePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: PersonalityPatch }) => elowenClient.updatePersonality(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Delete a personality profile (also clears any active pointer to it). Refresh the profiles list. */
export function useDeletePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => elowenClient.deletePersonality(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Pin a profile active. Refresh the profiles list (the server's active flag marks the badge). */
export function useActivatePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => elowenClient.activatePersonality(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Toggle a plugin on/off. Optimistic: the installed list AND the open detail flip instantly so the UI
 *  reacts immediately, without waiting for the daemon's hot-reload + refetch. On settle we re-fetch the
 *  list, the detail and its logs (health derives from the log ring) so everything reflects the real
 *  backend state; on error the optimistic change rolls back. */
export function useTogglePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; enabled: boolean }) => elowenClient.togglePlugin(v.name, v.enabled),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['plugins'] });
      const prevList = qc.getQueryData<PluginInfo[]>(['plugins']);
      const prevDetail = qc.getQueryData<PluginDetail>(['plugin', v.name]);
      qc.setQueryData<PluginInfo[]>(['plugins'], (cur) => cur?.map((p) => (p.name === v.name ? { ...p, enabled: v.enabled } : p)));
      qc.setQueryData<PluginDetail>(['plugin', v.name], (cur) => (cur ? { ...cur, enabled: v.enabled } : cur));
      return { prevList, prevDetail };
    },
    onError: (_e, v, ctx) => {
      if (ctx?.prevList) qc.setQueryData(['plugins'], ctx.prevList);
      if (ctx?.prevDetail) qc.setQueryData(['plugin', v.name], ctx.prevDetail);
    },
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] });
      void qc.invalidateQueries({ queryKey: ['plugin', v.name] });
      void qc.invalidateQueries({ queryKey: ['plugin-logs', v.name] });
      // A toggled plugin adds/removes its slash commands — re-pull the menu's single source of truth.
      void qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
    },
  });
}
/** Refresh both the marketplace catalog and the installed list after any install/update/uninstall/restore. */
function invalidatePluginViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['marketplace'] });
  void qc.invalidateQueries({ queryKey: ['plugins'] });
  void qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
}
/** Install a registry plugin into the user plugin dir (enabled by default). Applies live via hot-reload. */
export function useInstallPlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { name: string; enable?: boolean }) => elowenClient.installPlugin(v.name, v.enable ?? true), onSuccess: () => invalidatePluginViews(qc) });
}
/** Update an installed user plugin to the registry's newer version. */
export function useUpdatePlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => elowenClient.updatePlugin(name), onSuccess: () => invalidatePluginViews(qc) });
}
/** Remove a plugin — a user plugin is uninstalled (files deleted); a bundled plugin is soft-removed. */
export function useUninstallPlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => elowenClient.uninstallPlugin(name), onSuccess: () => invalidatePluginViews(qc) });
}
/** Restore a soft-removed bundled plugin (reappears disabled in the installed list). */
export function useRestorePlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => elowenClient.restorePlugin(name), onSuccess: () => invalidatePluginViews(qc) });
}
/** Replace the cronjob plugin's whole jobs array (auto-saved by the cron editor). */
export function useSaveCronJobs() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (jobs: CronJob[]) => elowenClient.saveCronJobs(jobs), onSuccess: () => qc.invalidateQueries({ queryKey: ['cron-jobs'] }) });
}
/** Create (or overwrite) a user skill of the skills plugin. Applies live via plugin hot-reload. */
export function useCreatePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: { name: string; description: string; content: string; disableModelInvocation?: boolean }) => elowenClient.createPluginSkill(skill),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}
/** Edit a user skill in place — description/content and the disable-model-invocation flag. */
export function useUpdatePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; patch: { description?: string; content?: string; disableModelInvocation?: boolean } }) => elowenClient.updatePluginSkill(v.name, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}
export function useDeletePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => elowenClient.deletePluginSkill(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}
export function useSavePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; values: Record<string, unknown> }) => elowenClient.savePluginConfig(v.name, v.values),
    onSuccess: (_r, v) => { void qc.invalidateQueries({ queryKey: ['plugin', v.name] }); void qc.invalidateQueries({ queryKey: ['plugins'] }); void qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands }); },
  });
}
/** Destructive — wipe the contents of a plugin's data directory. Refreshes that plugin's detail (data summary). */
export function useClearPluginData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => elowenClient.clearPluginData(name),
    onSuccess: (_r, name) => { void qc.invalidateQueries({ queryKey: ['plugin', name] }); },
  });
}
/** Replace the brain provider list (Settings → Brain). Refreshes the config and the models dropdown. */
export function useSaveBrainProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providers: NonNullable<NonNullable<ConfigPatch['brain']>['providers']>) => elowenClient.updateConfig({ brain: { providers } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: QUERY_KEYS.config }); void qc.invalidateQueries({ queryKey: ['brain-models'] }); },
  });
}
export function useBrainOauthDisconnect() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (type: string) => elowenClient.brainOauthDisconnect(type), onSuccess: () => qc.invalidateQueries({ queryKey: ['brain-oauth'] }) });
}
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { slug: string; path: string; notes?: string }) => elowenClient.createProject(v), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path?: string; notes?: string; pr_enabled?: boolean | null }) => elowenClient.updateProject(v.id, { path: v.path, notes: v.notes, pr_enabled: v.pr_enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => elowenClient.removeProject(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
/** Set (or clear, with icon: '') a project's icon — a project-relative image path chosen from the repo. */
export function useSetProjectIcon() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; icon: string }) => elowenClient.updateProject(v.id, { icon: v.icon }), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
/**
 * Toggle a project assignment for a user. `currentlyAssigned` is the present state of the chip:
 * when the project is already assigned we unassign it, otherwise we assign it. Naming the flag
 * after the current state (rather than a bare `assigned`) keeps the toggle direction unambiguous.
 */
export function useAssignProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userId: number; projectId: number; currentlyAssigned: boolean }) =>
      v.currentlyAssigned ? elowenClient.unassignProject(v.userId, v.projectId) : elowenClient.assignProject(v.userId, v.projectId),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: ['user-projects', v.userId] }),
  });
}
export function useWriteProjectFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; path: string; content: string }) => elowenClient.writeProjectFile(v.id, v.path, v.content),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['project-file', v.id, v.path] });
      qc.invalidateQueries({ queryKey: ['project-git', v.id] });
    },
  });
}
/** Invalidate everything that a file-tree mutation (create/rename/copy/delete) can affect. */
function invalidateProjectTree(qc: ReturnType<typeof useQueryClient>, id: number) {
  qc.invalidateQueries({ queryKey: ['project-files', id] });
  qc.invalidateQueries({ queryKey: ['project-git', id] });
  qc.invalidateQueries({ queryKey: ['project-changed', id] });
}
export function useNewProjectFile() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path: string }) => elowenClient.newProjectFile(v.id, v.path), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useNewProjectDir() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path: string }) => elowenClient.newProjectDir(v.id, v.path), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useRenameProjectEntry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; from: string; to: string }) => elowenClient.renameProjectEntry(v.id, v.from, v.to), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useCopyProjectEntry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; from: string; to: string }) => elowenClient.copyProjectEntry(v.id, v.from, v.to), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useDeleteProjectEntry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path: string }) => elowenClient.deleteProjectEntry(v.id, v.path), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
/** Create a memory (source 'user'). Refreshes the list and the audit feed. */
export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MemoryCreate) => elowenClient.createMemory(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Patch a memory (body/kind/importance/status). Refreshes the list, that memory's detail
 *  and audit trail, and the whole-user event feed. */
export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: MemoryPatch }) => elowenClient.updateMemory(v.id, v.patch),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
      qc.invalidateQueries({ queryKey: ['memory', v.id] });
      qc.invalidateQueries({ queryKey: ['memory-events'] });
    },
  });
}
/** Assign (or clear) a memory's category — a separate audited write (PUT /memory/:id/category), NOT a
 *  PATCH field. Refreshes the list, that memory's detail and the audit feed. */
export function useSetMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; categoryId: number | null }) => elowenClient.setMemoryCategory(v.id, v.categoryId),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
      qc.invalidateQueries({ queryKey: ['memory', v.id] });
      qc.invalidateQueries({ queryKey: ['memory-events'] });
    },
  });
}
/** Soft-delete a memory. Refreshes the list, that memory's detail and the audit feed. */
export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => elowenClient.deleteMemory(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
      qc.invalidateQueries({ queryKey: ['memory', id] });
      qc.invalidateQueries({ queryKey: ['memory-events'] });
    },
  });
}
/** Restore a soft-deleted memory back to active. */
export function useRestoreMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => elowenClient.restoreMemory(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.memories });
      qc.invalidateQueries({ queryKey: ['memory', id] });
      qc.invalidateQueries({ queryKey: ['memory-events'] });
    },
  });
}
/** Hard-delete many owned memories in one call — irreversible. Refreshes the list and audit feed. */
export function usePurgeMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => elowenClient.purgeMemories(ids),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Empty the trash — hard-delete ALL of the caller's soft-deleted memories. Refreshes list and audit feed. */
export function useEmptyTrash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.emptyTrash(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Merge several memories into a new one (sources soft-deleted). Refreshes the list and audit feed. */
export function useMergeMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids: number[]; body: string }) => elowenClient.mergeMemories(v.ids, v.body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Re-embed the caller's pending memories. Refreshes the list (embedding status) and settings (counts). */
export function useReindexMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.reindexMemories(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.embeddingSettings }); },
  });
}
/** Save the workspace embedding provider settings (admin). Refreshes the settings query. */
export function useSaveEmbeddingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: EmbeddingSettingsPatch) => elowenClient.saveEmbeddingSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.embeddingSettings }),
  });
}
/** Create a memory category. Refreshes the category list and the memory list (badges/filters). */
export function useCreateMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MemoryCategoryCreate) => elowenClient.createMemoryCategory(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); },
  });
}
/** Patch a memory category (name/description/color). Refreshes the category list and the memory list. */
export function useUpdateMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { cid: number; patch: MemoryCategoryPatch }) => elowenClient.updateMemoryCategory(v.cid, v.patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); },
  });
}
/** Delete a memory category (clears category_id on referencing memories). Refreshes categories and memories. */
export function useDeleteMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cid: number) => elowenClient.deleteMemoryCategory(cid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); },
  });
}
/** Save the workspace categorization provider settings (admin). Refreshes the settings query. */
export function useSaveCategorizationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: CategorizationSettingsPatch) => elowenClient.saveCategorizationSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.categorizationSettings }),
  });
}
/** Re-run categorization over the caller's memories. Refreshes the memory list (new category assignments). */
export function useReclassifyMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { limit?: number; includeCategorized?: boolean }) => elowenClient.reclassifyMemories(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }),
  });
}
export function useAdvisorStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exec: string) => elowenClient.advisorStart(exec),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.advisorStatus }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
export function useAdvisorStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.advisorStop(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.advisorStatus }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
