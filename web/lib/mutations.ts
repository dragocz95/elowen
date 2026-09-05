'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ElowenApiError, elowenClient } from './elowenClient';
import { clearToken } from './token';
import { QUERY_KEYS } from './queries';
import type { ConfigPatch, ConfigSnapshot, UserPatch, ProfilePatch, CliSettings, TerminalSettings, TerminalSettingsSnapshot, PermissionSettings, NavLayout, CronJob, MemoryCreate, MemoryPatch, EmbeddingSettingsPatch, MemoryCategoryCreate, MemoryCategoryPatch, CategorizationSettingsPatch, MemoryMaintenanceState, MemoryRecategorizeMode, PluginInfo, PluginDetail, PluginSkill, SessionTask, SessionTaskPatch, UserPluginConfigDetail } from './types';

/** Admin: clear the caller's brain usage and origin rollup. */
export function useResetUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.resetUsage(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.usageByModel });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.usageByDay });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.usageByOrigin });
    },
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ConfigPatch) => {
      const current = qc.getQueryData<ConfigSnapshot>(QUERY_KEYS.config);
      return elowenClient.updateConfig(patch, current?.revision);
    },
    onSuccess: (snapshot) => { qc.setQueryData(QUERY_KEYS.config, snapshot); },
    // A conflict is a successful read of newer canonical state. Keep the draft in its owner, but advance
    // the shared cache so an explicit Retry uses the current revision instead of repeating the same 409.
    onError: (error) => {
      if (!(error instanceof ElowenApiError) || error.status !== 409) return;
      const current = error.details?.current;
      if (current && typeof current === 'object' && !Array.isArray(current)
        && typeof (current as { revision?: unknown }).revision === 'number') {
        qc.setQueryData(QUERY_KEYS.config, current as ConfigSnapshot);
      }
    },
  });
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
export function useLogin() {
  return useMutation({ mutationFn: (v: { username: string; password: string }) => elowenClient.login(v.username, v.password) });
}
/** Internal to `useSignOut` — ending a session always has to clear the cookie and reload, so nothing
 *  outside this file should call the bare mutation and re-implement that half. */
function useLogout() {
  return useMutation({ mutationFn: () => elowenClient.logout() });
}
/** Ending a session, ready to hand straight to an onClick. The cookie is cleared and the page reloaded on
 *  EITHER outcome on purpose: when the daemon is already unreachable the request fails, and leaving the
 *  user inside a session the UI still believes in is the one result a logout button must never produce. */
export function useSignOut(): { signOut: () => void; isPending: boolean } {
  const logout = useLogout();
  const finish = (): void => { clearToken(); window.location.reload(); };
  return {
    signOut: () => logout.mutate(undefined, { onSuccess: finish, onError: finish }),
    isPending: logout.isPending,
  };
}
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { username: string; password: string }) => elowenClient.createUser(v.username, v.password), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => elowenClient.deleteUser(id), onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['users'] }), qc.invalidateQueries({ queryKey: ['project-summaries'] })]); } });
}
export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: UserPatch }) => elowenClient.updateUser(v.id, v.patch),
    onSuccess: async (_user, { id, patch }) => {
      const invalidations = [
        qc.invalidateQueries({ queryKey: ['users'] }),
        qc.invalidateQueries({ queryKey: ['me'] }),
        // Names and role changes affect Project member samples and counts.
        qc.invalidateQueries({ queryKey: ['project-summaries'] }),
      ];
      // The effective tool list is derived from the plugin grant as well as the per-tool grant. Refresh
      // its one user-scoped cache whenever either input changes so the Users drawer never needs an F5.
      if (patch.granted_plugins || patch.allowed_tools || patch.disabled_tools) {
        invalidations.push(qc.invalidateQueries({ queryKey: ['user-tools', id] }));
      }
      await Promise.all(invalidations);
    },
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
export function useSaveUserPluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; values: Record<string, unknown>; expectedRevision?: number }) => elowenClient.saveUserPluginConfig(v.name, v.values, v.expectedRevision),
    onSuccess: (detail) => qc.setQueryData<UserPluginConfigDetail[]>(QUERY_KEYS.userPluginConfigs, (current) => current?.map((item) => item.name === detail.name ? detail : item)),
  });
}

export function useSaveMyCliSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CliSettings>) => elowenClient.saveMyCliSettings(patch, qc.getQueryData<CliSettings>(['my-cli-settings'])?.revision),
    onSuccess: (saved) => qc.setQueryData(['my-cli-settings'], saved),
    onError: (error) => { if (error instanceof ElowenApiError && error.status === 409) { const current = error.details?.current; if (current) qc.setQueryData(['my-cli-settings'], current); } },
  });
}
export function useSaveMyTerminalSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<TerminalSettings>) => elowenClient.saveMyTerminalSettings(patch, qc.getQueryData<TerminalSettingsSnapshot>(['my-terminal-settings'])?.revision),
    onSuccess: (saved) => qc.setQueryData(['my-terminal-settings'], saved),
    onError: (error) => { if (error instanceof ElowenApiError && error.status === 409) { const current = error.details?.current; if (current) qc.setQueryData(['my-terminal-settings'], current); } },
  });
}
export function useSaveMyPermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<PermissionSettings>) => elowenClient.saveMyPermissions(patch, qc.getQueryData<PermissionSettings>(['my-permissions'])?.revision),
    onSuccess: (saved) => qc.setQueryData(['my-permissions'], saved),
    onError: (error) => { if (error instanceof ElowenApiError && error.status === 409) { const current = error.details?.current; if (current) qc.setQueryData(['my-permissions'], current); } },
  });
}
/** Save the navigation layout. The route answers with the whole sanitized layout, so the cache is written
 *  from the response instead of invalidated — the menu must not flicker back to its old arrangement while
 *  a refetch is in flight. */
export function useSaveMyNavSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<NavLayout>) => elowenClient.saveMyNavSettings(patch, qc.getQueryData<NavLayout>(['my-nav-settings'])?.revision),
    onSuccess: (layout) => { qc.setQueryData(['my-nav-settings'], layout); },
    // The menu writes the new arrangement into the cache before the round trip, so a rejected save has
    // to be undone from the server rather than left showing an arrangement that was never stored.
    onError: (error) => {
      if (error instanceof ElowenApiError && error.status === 409 && error.details?.current) qc.setQueryData(['my-nav-settings'], error.details.current);
      else void qc.invalidateQueries({ queryKey: ['my-nav-settings'] });
    },
  });
}
/** Delete one log file. Both the list and any cached read of that file are dropped — the viewer must not
 *  keep showing the contents of a file that is gone. */
export function useDeleteLogFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => elowenClient.deleteLogFile(name),
    onSuccess: (_d, name) => {
      void qc.invalidateQueries({ queryKey: ['log-files'] });
      void qc.removeQueries({ queryKey: ['log-file', name] });
    },
  });
}
/** Delete every log file. Drops every cached read, since none of them still exist. */
export function useDeleteAllLogFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.deleteAllLogFiles(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['log-files'] });
      void qc.removeQueries({ queryKey: ['log-file'] });
    },
  });
}
/** Toggle a plugin on/off. Optimistic: the installed list AND the open detail flip instantly so the UI
 *  reacts immediately, without waiting for the daemon's hot-reload + refetch. On settle we re-fetch the
 *  list, the detail and its logs (health derives from the log ring) so everything reflects the real
 *  backend state; on error the optimistic change rolls back. */
export function useTogglePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; enabled: boolean; acknowledgeGrants?: string[] }) =>
      elowenClient.togglePlugin(v.name, v.enabled, v.acknowledgeGrants),
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
      // …and its browser UI (sidebar world + /p/<name> pages) appears/disappears with it.
      void qc.invalidateQueries({ queryKey: QUERY_KEYS.pluginUi });
    },
  });
}
/** Refresh both the marketplace catalog and the installed list after any install/update/uninstall/restore. */
function invalidatePluginViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['marketplace'] });
  void qc.invalidateQueries({ queryKey: ['plugins'] });
  void qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
  void qc.invalidateQueries({ queryKey: QUERY_KEYS.pluginUi });
}
/** Install a registry plugin into the user plugin dir (enabled by default). Applies live via hot-reload. */
export function useInstallPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; enable?: boolean; acknowledgeGrants?: string[] }) => elowenClient.installPlugin(v.name, v.enable ?? true, v.acknowledgeGrants),
    onSuccess: () => invalidatePluginViews(qc),
    // A grant refusal still leaves the downloaded plugin inert on disk. Refresh both views so cancelling
    // the consent question reflects that committed, disabled install instead of leaving stale catalog data.
    onError: (error) => { if ((error as { details?: { installed?: unknown } }).details?.installed === true) invalidatePluginViews(qc); },
  });
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
/** Persist ONE cron job (auto-saved per row by the cron editor) — never the whole list, which a stale
 *  page would use to delete jobs added meanwhile by the scheduler or the brain's cron tools. */
export function useSaveCronJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (job: CronJob) => elowenClient.saveCronJob(job), onSuccess: () => qc.invalidateQueries({ queryKey: ['cron-jobs'] }) });
}
/** Delete ONE cron job. */
export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => elowenClient.deleteCronJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['cron-jobs'] }) });
}
/** Create (or overwrite) a user skill of the skills plugin. Applies live via plugin hot-reload. */
export function useCreatePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: { name: string; description: string; content: string; disableModelInvocation?: boolean; owner?: number | 'instance' | null }) => elowenClient.createPluginSkill(skill),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}
/** Edit a user skill in place — description/content and the disable-model-invocation flag. Optimistic:
 *  the row flips instantly (the daemon's plugin hot-reload can take a while, and the old wait-for-refetch
 *  behaviour left the toggle greyed out until a manual reload). On error the change rolls back; on settle
 *  the list re-fetches the real backend state. */
export function useUpdatePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; owner?: number | 'instance' | null; patch: { description?: string; content?: string; disableModelInvocation?: boolean } }) => elowenClient.updatePluginSkill(v.name, v.patch, v.owner),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['plugin-skills'] });
      const prev = qc.getQueryData<PluginSkill[]>(['plugin-skills']);
      // Match on name AND owner: the same name can legitimately exist for two accounts, and an
      // optimistic patch keyed on the name alone would flip a row belonging to someone else.
      const targetOwner = v.owner === 'instance' || v.owner == null ? null : v.owner;
      qc.setQueryData<PluginSkill[]>(['plugin-skills'], (cur) => cur?.map((s) => (s.name === v.name && (s.owner ?? null) === targetOwner ? { ...s, ...v.patch } : s)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['plugin-skills'], ctx.prev); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['plugin-skills'] }); },
  });
}
/** Patch one session task: status, subject, owner, or any combination. Every field is optional, so the
 *  original status-only call shape still applies; the daemon refuses a patch that names nothing. */
export function useUpdateSessionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, taskId, ...patch }: { sessionId: string; taskId: string } & SessionTaskPatch) =>
      elowenClient.updateSessionTask(sessionId, taskId, patch),
    onMutate: async ({ sessionId, taskId, ...patch }) => {
      const key = ['session-tasks', sessionId];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ tasks: SessionTask[] }>(key);
      // A cleared owner arrives as null/'' on the wire but is simply absent on a task, so mirror that
      // rather than leaving an empty chip in the optimistic row.
      const applied: Partial<SessionTask> = {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.owner !== undefined ? { owner: patch.owner || undefined } : {}),
      };
      qc.setQueryData<{ tasks: SessionTask[] }>(key, (cur) => cur ? { tasks: cur.tasks.map((task) => task.id === taskId ? { ...task, ...applied } : task) } : cur);
      return { key, prev };
    },
    onError: (_error, _value, context) => { if (context?.prev) qc.setQueryData(context.key, context.prev); },
    onSettled: (_data, _error, value) => { void qc.invalidateQueries({ queryKey: ['session-tasks', value.sessionId] }); },
  });
}

export function useDeleteSessionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sessionId: string; taskId: string }) => elowenClient.deleteSessionTask(v.sessionId, v.taskId),
    onSuccess: (_data, value) => qc.invalidateQueries({ queryKey: ['session-tasks', value.sessionId] }),
  });
}

export function useClearSessionTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sessionId: string; scope: 'completed' | 'all' }) => elowenClient.clearSessionTasks(v.sessionId, v.scope),
    onSuccess: (_data, value) => qc.invalidateQueries({ queryKey: ['session-tasks', value.sessionId] }),
  });
}

export function useDeletePluginSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; owner?: number | 'instance' | null }) => elowenClient.deletePluginSkill(v.name, v.owner),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-skills'] }),
  });
}

/** Create a sandbox workspace — a real Git worktree cut from `baseRef`. Nothing here is optimistic: the
 *  daemon allocates the branch and the directory, and only its answer says what was actually made. */
export function useCreateSandboxWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: number; label: string; baseRef: string }) => elowenClient.createSandboxWorkspace(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.sandboxOverview }),
  });
}

/** Point THIS conversation at a workspace. The binding is server-side and the daemon derives the turn's
 *  working directory from it, so the only client-side consequence is that the overview must be re-read:
 *  the active mark lives in each workspace's `bindings`, which this write has just moved. */
export function useUseSandboxWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workspaceId: string; sessionId: string }) => elowenClient.useSandboxWorkspace(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.sandboxOverview }),
  });
}

/** Give THIS conversation its project directory back. The inverse of the switch above and equally
 *  server-side: the plugin drops the conversation's binding rows and keeps every workspace, so the only
 *  client-side consequence is the same one a switch has — the overview carries the active mark, and this
 *  write has just cleared it. */
export function useReleaseSandboxWorkspaces() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sessionId: string }) => elowenClient.releaseSandboxWorkspaces(v.sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.sandboxOverview }),
  });
}

/** Ask what removing a workspace would take with it. A read, expressed as a mutation because it is a POST
 *  the reader triggers deliberately rather than something worth holding in the cache. */
export function useSandboxRemovalPreview() {
  return useMutation({
    mutationFn: (v: { workspaceId: string }) => elowenClient.sandboxRemovalPreview(v.workspaceId),
  });
}

/** Remove a workspace along the SAFE path. The daemon refuses an unclean tree, unpushed commits or a
 *  running process with a coded error, and the drawer reports that refusal rather than escalating —
 *  discarding work is the plugin's own settings screen, never a chat drawer. */
export function useRemoveSandboxWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workspaceId: string }) => elowenClient.removeSandboxWorkspace(v.workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.sandboxOverview }),
  });
}
/** Create (or overwrite) a user sub-agent of the subagent plugin. Applies live via plugin hot-reload. */
export function useSavePluginSubagent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; def: { description: string; tools: 'read-only' | 'all' | 'inherit' | string[]; body: string } }) => elowenClient.savePluginSubagent(v.name, v.def),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-subagents'] }),
  });
}
export function useDeletePluginSubagent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => elowenClient.deletePluginSubagent(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-subagents'] }),
  });
}
export function useSavePluginConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; values: Record<string, unknown>; expectedRevision?: number }) => elowenClient.savePluginConfig(v.name, v.values, v.expectedRevision),
    onSuccess: (response, v) => {
      if (response.config && response.secretsSet && response.revision !== undefined) {
        qc.setQueryData<PluginDetail>(['plugin', v.name], (current) => current ? {
          ...current, config: response.config!, secretsSet: response.secretsSet!, revision: response.revision,
        } : current);
      }
      void qc.invalidateQueries({ queryKey: ['plugins'] });
      void qc.invalidateQueries({ queryKey: QUERY_KEYS.brainCommands });
    },
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
    mutationFn: (providers: NonNullable<NonNullable<ConfigPatch['brain']>['providers']>) => {
      const current = qc.getQueryData<ConfigSnapshot>(QUERY_KEYS.config);
      return elowenClient.updateConfig({ brain: { providers } }, current?.revision);
    },
    onSuccess: (snapshot) => { qc.setQueryData(QUERY_KEYS.config, snapshot); void qc.invalidateQueries({ queryKey: ['brain-models'] }); },
  });
}
export function useBrainOauthDisconnect() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (type: string) => elowenClient.brainOauthDisconnect(type), onSuccess: () => qc.invalidateQueries({ queryKey: ['brain-oauth'] }) });
}
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { slug: string; path: string; notes?: string }) => elowenClient.createProject(v), onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['project-summaries'] })]); } });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; path?: string; notes?: string; memoryShared?: boolean }) => elowenClient.updateProject(v.id, { path: v.path, notes: v.notes, memoryShared: v.memoryShared }), onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['project-summaries'] })]); } });
}

/** Create a child under the open directory. `listingPath` is the actual query key that produced the
 * canonical parent, which can differ when the picker started at the server's default home directory. */
export function useCreateDirectory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { parent: string; name: string; listingPath?: string }) => elowenClient.createDir(v.parent, v.name),
    onSuccess: async (_created, v) => {
      const originalKey = v.listingPath ?? '';
      const keys = originalKey === v.parent ? [originalKey] : [originalKey, v.parent];
      await Promise.all(keys.map((key) => qc.invalidateQueries({ queryKey: ['fs-dirs', key], exact: true, refetchType: 'active' })));
    },
  });
}
/** Replace a project's shared-memory share list wholesale (admin-only). */
export function useSetProjectMemoryMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: number; userIds: number[] }) => elowenClient.setProjectMemoryMembers(v.projectId, v.userIds),
    onSuccess: async (_r, v) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['project-memory-members', v.projectId] }),
        qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories }),
        qc.invalidateQueries({ queryKey: QUERY_KEYS.memories }),
      ]);
    },
  });
}
export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => elowenClient.removeProject(id), onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['project-summaries'] })]); } });
}
/** Set (or clear, with icon: '') a project's icon — a project-relative image path chosen from the repo. */
export function useSetProjectIcon() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: number; icon: string }) => elowenClient.updateProject(v.id, { icon: v.icon }), onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['project-summaries'] })]); } });
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
    onSuccess: async (_r, v) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['user-projects', v.userId] }),
        qc.invalidateQueries({ queryKey: ['project-users', v.projectId] }),
        qc.invalidateQueries({ queryKey: ['project-summaries'] }),
      ]);
    },
  });
}
const inFlightFileWrites = new Map<string, Promise<{ ok: boolean }>>();
/** Saving is not gated on `isPending` (Cmd+S fires whenever), so two writes to the SAME file can be
 *  in flight at once — and then the slower, older request can settle last and put its stale content
 *  back into the cache and onto disk. Chain the writes per project + path so that never happens,
 *  while writes to different files (or projects) still run in parallel. react-query's `scope` can't
 *  express this: its id is fixed in the hook's options, but the file only arrives with the variables. */
function writeProjectFileSerialized(id: number, path: string, content: string): Promise<{ ok: boolean }> {
  const key = `${id}\u0000${path}`;
  const previous = inFlightFileWrites.get(key);
  // allSettled: a failed write must not block the next save of that file.
  const run = Promise.allSettled([previous]).then(() => elowenClient.writeProjectFile(id, path, content));
  inFlightFileWrites.set(key, run);
  return run.finally(() => { if (inFlightFileWrites.get(key) === run) inFlightFileWrites.delete(key); });
}
export function useWriteProjectFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; path: string; content: string }) => writeProjectFileSerialized(v.id, v.path, v.content),
    onSuccess: (_r, v) => {
      // Update the file cache with what we just wrote before invalidating — the editor clears its local
      // draft on save and falls back to this cache, so without the update it would briefly flash the
      // stale pre-save content until the refetch below resolves.
      qc.setQueryData<{ content: string; truncated: boolean }>(['project-file', v.id, v.path], { content: v.content, truncated: false });
      qc.invalidateQueries({ queryKey: ['project-file', v.id, v.path] });
      qc.invalidateQueries({ queryKey: ['project-git', v.id] });
      // 'project-changed' is where the editor gets its highlighted (dirty) paths — without this the tree
      // keeps claiming the just-saved path is unchanged until something else invalidates it.
      qc.invalidateQueries({ queryKey: ['project-changed', v.id] });
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
/** Start owner-scoped background reindexing and refresh its progress slot. */
export function useStartMemoryReindex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => elowenClient.startMemoryReindex(),
    onSuccess: (job) => {
      qc.setQueryData(QUERY_KEYS.memoryMaintenance, (current: MemoryMaintenanceState | undefined) => current ? { ...current, reindex: job } : current);
      void qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryMaintenance });
    },
  });
}

/** Start owner-scoped background recategorization and refresh its progress slot. */
export function useStartMemoryRecategorize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: MemoryRecategorizeMode) => elowenClient.startMemoryRecategorize(mode),
    onSuccess: (job) => {
      qc.setQueryData(QUERY_KEYS.memoryMaintenance, (current: MemoryMaintenanceState | undefined) => current ? { ...current, recategorize: job } : current);
      void qc.invalidateQueries({ queryKey: QUERY_KEYS.memoryMaintenance });
    },
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
