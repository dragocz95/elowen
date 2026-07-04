'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { orcaClient } from './orcaClient';
import { QUERY_KEYS } from './queries';
import type { CreateTaskInput, UpdateTaskInput, PlanInput, EngageInput, ConfigPatch, InsertPhasesInput, UserPatch, ProfilePatch, CliSettings, CronJob, PersonalityCreate, PersonalityPatch, MemoryCreate, MemoryPatch, EmbeddingSettingsPatch, MemoryCategoryCreate, MemoryCategoryPatch, CategorizationSettingsPatch } from './types';

export function useSpawn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; exec?: string }) => orcaClient.spawn(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CreateTaskInput) => orcaClient.createTask(input), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string; patch: UpdateTaskInput }) => orcaClient.updateTask(v.id, v.patch), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.deleteTask(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useDeleteMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) => orcaClient.deleteMission(epicId),
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
    mutationFn: () => orcaClient.resetUsage(),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.usageByModel }),
  });
}

export function useCleanupAll() {
  const qc = useQueryClient();
  // cleanupAll disengages every mission, kills the orca- sessions and wipes tasks + events. Invalidate
  // exactly those caches (+ the mission detail and session signals derived from them) instead of a
  // wildcard `invalidateQueries()` — config/system/users/usage don't change, so refetching them just
  // re-hammers the daemon for no reason.
  return useMutation({
    mutationFn: () => orcaClient.cleanupAll(),
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
    mutationFn: (input: PlanInput) => orcaClient.planTask(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }); qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }); },
  });
}
export function useInsertPhases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { epicId: string; body: InsertPhasesInput }) => orcaClient.insertPhases(v.epicId, v.body),
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
  return useMutation({ mutationFn: (id: string) => orcaClient.closeTask(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useSetTaskStatus() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string; status: string }) => orcaClient.setTaskStatus(v.id, v.status), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useApproveGate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.approveGate(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
}
export function useReplyAsk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string; askId: string; text: string }) => orcaClient.replyAsk(v.taskId, v.askId, v.text),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['pending-asks'] }); qc.invalidateQueries({ queryKey: ['task-activity', v.taskId] }); },
  });
}
export function useSetTaskExec() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string; exec: string }) => orcaClient.setTaskExec(v.id, v.exec), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.tasks }) });
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
  return useMutation({ mutationFn: (input: EngageInput) => orcaClient.engage(input), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
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
export function useOpenMissionPr() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.openMissionPr(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useMergeMissionPr() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => orcaClient.mergeMissionPr(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.missions }) });
}
export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: ConfigPatch) => orcaClient.updateConfig(patch), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.config }) });
}
/** Trigger a manual in-place update. The daemon restarts mid-flight, so the System panel just re-polls
 *  /system afterwards to pick up the new version. */
export function useSystemUpdate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => orcaClient.systemUpdate(), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.system }) });
}
/** Restart one of the systemd units. No invalidation — a daemon restart drops the API for a few
 *  seconds anyway; the System panel's regular polling picks the service back up on its own. */
export function useSystemRestart() {
  return useMutation({ mutationFn: (target: 'daemon' | 'web') => orcaClient.systemRestart(target) });
}
export function useInstallSkills() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => orcaClient.installSkills(), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.systemSkills }) });
}
export function useLogin() {
  return useMutation({ mutationFn: (v: { username: string; password: string }) => orcaClient.login(v.username, v.password) });
}
export function useLogout() {
  return useMutation({ mutationFn: () => orcaClient.logout() });
}
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { username: string; password: string }) => orcaClient.createUser(v.username, v.password), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => orcaClient.deleteUser(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
}
export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: UserPatch }) => orcaClient.updateUser(v.id, v.patch),
    // Refresh the list and the current identity (an admin could change their own role).
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
}
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: ProfilePatch) => orcaClient.updateMe(patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
}
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (file: File) => orcaClient.uploadAvatar(file), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
}
export function useChangePassword() {
  return useMutation({ mutationFn: (v: { currentPassword: string; newPassword: string }) => orcaClient.changePassword(v.currentPassword, v.newPassword) });
}
export function useSaveMyPrompt() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { name: string; content: string }) => orcaClient.saveMyPrompt(v.name, v.content), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-prompts'] }) });
}
export function useSaveMyCliSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: Partial<CliSettings>) => orcaClient.saveMyCliSettings(patch), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-cli-settings'] }) });
}
/** Create a personality profile. Invalidates the profiles list (all platforms). */
export function useCreatePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PersonalityCreate) => orcaClient.createPersonality(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Patch a personality profile. Refresh the profiles list (the server carries the authoritative active flag). */
export function useUpdatePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: PersonalityPatch }) => orcaClient.updatePersonality(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Delete a personality profile (also clears any active pointer to it). Refresh the profiles list. */
export function useDeletePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => orcaClient.deletePersonality(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
/** Pin a profile active. Refresh the profiles list (the server's active flag marks the badge). */
export function useActivatePersonality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => orcaClient.activatePersonality(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personalities'] }),
  });
}
export function useTogglePlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { name: string; enabled: boolean }) => orcaClient.togglePlugin(v.name, v.enabled), onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }) });
}
/** Refresh both the marketplace catalog and the installed list after any install/update/uninstall. */
function invalidatePluginViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['marketplace'] });
  void qc.invalidateQueries({ queryKey: ['plugins'] });
}
/** Install a registry plugin into the user plugin dir (enabled by default). Applies live via hot-reload. */
export function useInstallPlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { name: string; enable?: boolean }) => orcaClient.installPlugin(v.name, v.enable ?? true), onSuccess: () => invalidatePluginViews(qc) });
}
/** Update an installed user plugin to the registry's newer version. */
export function useUpdatePlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => orcaClient.updatePlugin(name), onSuccess: () => invalidatePluginViews(qc) });
}
/** Uninstall a user plugin — removes its folder AND its data. */
export function useUninstallPlugin() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => orcaClient.uninstallPlugin(name), onSuccess: () => invalidatePluginViews(qc) });
}
/** Replace the cronjob plugin's whole jobs array (auto-saved by the cron editor). */
export function useSaveCronJobs() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (jobs: CronJob[]) => orcaClient.saveCronJobs(jobs), onSuccess: () => qc.invalidateQueries({ queryKey: ['cron-jobs'] }) });
}
/** Create (or overwrite) a user skill of the skills plugin. Applies live via plugin hot-reload. */
export function useCreatePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: { name: string; description: string; content: string }) => orcaClient.createPluginSkill(skill),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}
export function useDeletePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => orcaClient.deletePluginSkill(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}
export function useSavePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; values: Record<string, unknown> }) => orcaClient.savePluginConfig(v.name, v.values),
    onSuccess: (_r, v) => { void qc.invalidateQueries({ queryKey: ['plugin', v.name] }); void qc.invalidateQueries({ queryKey: ['plugins'] }); },
  });
}
/** Destructive — wipe the contents of a plugin's data directory. Refreshes that plugin's detail (data summary). */
export function useClearPluginData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => orcaClient.clearPluginData(name),
    onSuccess: (_r, name) => { void qc.invalidateQueries({ queryKey: ['plugin', name] }); },
  });
}
/** Replace the brain provider list (Settings → Brain). Refreshes the config and the models dropdown. */
export function useSaveBrainProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providers: NonNullable<NonNullable<ConfigPatch['brain']>['providers']>) => orcaClient.updateConfig({ brain: { providers } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: QUERY_KEYS.config }); void qc.invalidateQueries({ queryKey: ['brain-models'] }); },
  });
}
export function useBrainOauthDisconnect() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (type: string) => orcaClient.brainOauthDisconnect(type), onSuccess: () => qc.invalidateQueries({ queryKey: ['brain-oauth'] }) });
}
export function useResetMyPrompt() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => orcaClient.resetMyPrompt(name), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-prompts'] }) });
}
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { slug: string; path: string; notes?: string }) => orcaClient.createProject(v), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path?: string; notes?: string; pr_enabled?: boolean | null }) => orcaClient.updateProject(v.id, { path: v.path, notes: v.notes, pr_enabled: v.pr_enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => orcaClient.removeProject(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
}
/** Set (or clear, with icon: '') a project's icon — a project-relative image path chosen from the repo. */
export function useSetProjectIcon() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; icon: string }) => orcaClient.updateProject(v.id, { icon: v.icon }), onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }) });
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
      v.currentlyAssigned ? orcaClient.unassignProject(v.userId, v.projectId) : orcaClient.assignProject(v.userId, v.projectId),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: ['user-projects', v.userId] }),
  });
}
export function useWriteProjectFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; path: string; content: string }) => orcaClient.writeProjectFile(v.id, v.path, v.content),
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
  return useMutation({ mutationFn: (v: { id: number; path: string }) => orcaClient.newProjectFile(v.id, v.path), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useNewProjectDir() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path: string }) => orcaClient.newProjectDir(v.id, v.path), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useRenameProjectEntry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; from: string; to: string }) => orcaClient.renameProjectEntry(v.id, v.from, v.to), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useCopyProjectEntry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; from: string; to: string }) => orcaClient.copyProjectEntry(v.id, v.from, v.to), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
export function useDeleteProjectEntry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path: string }) => orcaClient.deleteProjectEntry(v.id, v.path), onSuccess: (_r, v) => invalidateProjectTree(qc, v.id) });
}
/** Create a memory (source 'user'). Refreshes the list and the audit feed. */
export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MemoryCreate) => orcaClient.createMemory(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Patch a memory (body/kind/importance/status). Refreshes the list, that memory's detail
 *  and audit trail, and the whole-user event feed. */
export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: MemoryPatch }) => orcaClient.updateMemory(v.id, v.patch),
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
    mutationFn: (v: { id: number; categoryId: number | null }) => orcaClient.setMemoryCategory(v.id, v.categoryId),
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
    mutationFn: (id: number) => orcaClient.deleteMemory(id),
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
    mutationFn: (id: number) => orcaClient.restoreMemory(id),
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
    mutationFn: (ids: number[]) => orcaClient.purgeMemories(ids),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Empty the trash — hard-delete ALL of the caller's soft-deleted memories. Refreshes list and audit feed. */
export function useEmptyTrash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => orcaClient.emptyTrash(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Merge several memories into a new one (sources soft-deleted). Refreshes the list and audit feed. */
export function useMergeMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids: number[]; body: string }) => orcaClient.mergeMemories(v.ids, v.body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: ['memory-events'] }); },
  });
}
/** Re-embed the caller's pending memories. Refreshes the list (embedding status) and settings (counts). */
export function useReindexMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => orcaClient.reindexMemories(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.embeddingSettings }); },
  });
}
/** Save the workspace embedding provider settings (admin). Refreshes the settings query. */
export function useSaveEmbeddingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: EmbeddingSettingsPatch) => orcaClient.saveEmbeddingSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.embeddingSettings }),
  });
}
/** Create a memory category. Refreshes the category list and the memory list (badges/filters). */
export function useCreateMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MemoryCategoryCreate) => orcaClient.createMemoryCategory(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); },
  });
}
/** Patch a memory category (name/description/color). Refreshes the category list and the memory list. */
export function useUpdateMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { cid: number; patch: MemoryCategoryPatch }) => orcaClient.updateMemoryCategory(v.cid, v.patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); },
  });
}
/** Delete a memory category (clears category_id on referencing memories). Refreshes categories and memories. */
export function useDeleteMemoryCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cid: number) => orcaClient.deleteMemoryCategory(cid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }); qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }); },
  });
}
/** Save the workspace categorization provider settings (admin). Refreshes the settings query. */
export function useSaveCategorizationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: CategorizationSettingsPatch) => orcaClient.saveCategorizationSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.categorizationSettings }),
  });
}
/** Re-run categorization over the caller's memories. Refreshes the memory list (new category assignments). */
export function useReclassifyMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { limit?: number; includeCategorized?: boolean }) => orcaClient.reclassifyMemories(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }),
  });
}
export function useAdvisorStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exec: string) => orcaClient.advisorStart(exec),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.advisorStatus }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
export function useAdvisorStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => orcaClient.advisorStop(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.advisorStatus }); qc.invalidateQueries({ queryKey: QUERY_KEYS.sessions }); },
  });
}
