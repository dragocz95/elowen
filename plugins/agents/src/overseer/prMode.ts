/** Resolve whether the PR-native (isolated worktree) workflow is on, from the three-level override
 *  chain — most specific first: an explicit per-task override, then the project's `pr_enabled`, then
 *  the global autopilot default. Single source of truth shared by runtime (missionGit, deriving the
 *  override from the epic's `pr:on`/`pr:off` label) and planning time (the pilot, passing
 *  `job.prEnabled` directly) — the label and `job.prEnabled` are the same per-task choice. */
export function resolvePrEnabled(
  override: boolean | null,
  projectPrEnabled: boolean | null | undefined,
  globalDefault: boolean,
): boolean {
  if (override !== null) return override;
  if (projectPrEnabled != null) return projectPrEnabled;
  return globalDefault;
}
