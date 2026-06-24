import { dirname, join } from 'node:path';
import type { MissionPrStore } from '../store/missionPrStore.js';
import type { ConfigStore } from '../store/configStore.js';
import type { Task } from '../store/types.js';
import { logger } from '../shared/logger.js';
import { createMissionWorktree, removeWorktree, commitAll, detectBaseBranch } from '../integrations/git/worktree.js';

const log = logger('mission-git');

export interface MissionGitDeps {
  prs: MissionPrStore;
  config: ConfigStore;
  projects: { get(id: number): { id: number; slug: string; path: string } | null };
  tasks: { get(id: string): Task | null };
}

/** Single source of truth for what happens to git across a mission's lifecycle: branch + worktree on
 *  engage, commit per approved phase, and worktree cleanup on pause/disengage. PR opening and feedback
 *  ingestion (later stages) live here too so the git story stays in one place. Everything is a no-op
 *  when PR-native mode is off, so the rest of autopilot is unaffected. */
export class MissionGit {
  constructor(private d: MissionGitDeps) {}

  private prEnabled(): boolean { return this.d.config.get().autopilot.prEnabled; }

  /** The project a mission belongs to, resolved via its epic (mission id is `m-<epicId>`). */
  private projectFor(missionId: string): { id: number; slug: string; path: string } | null {
    const epicId = missionId.replace(/^m-/, '');
    const epic = this.d.tasks.get(epicId);
    return epic ? this.d.projects.get(epic.project_id) : null;
  }

  /** On engage: when PR-native mode is on, carve a dedicated branch + sibling worktree for the mission
   *  and record it. Idempotent — re-engaging reuses the stored worktree. No-op when disabled, or when
   *  the project/worktree can't be set up (logged; autopilot continues in the main checkout). */
  async onEngage(missionId: string, epicId: string): Promise<void> {
    if (!this.prEnabled()) return;
    if (this.d.prs.get(missionId)) return; // already provisioned (re-engage)
    const project = this.projectFor(missionId);
    if (!project) { log.warn(`PR mode: no project for mission ${missionId} — skipping worktree`); return; }
    const slug = sanitize(project.slug);
    const branch = `orca/${slug}-${sanitize(epicId)}`;
    const dir = join(dirname(project.path), '.orca-worktrees', `${slug}-${missionId}`);
    try {
      const base = await detectBaseBranch(project.path, this.d.config.get().autopilot.prBaseBranch);
      await createMissionWorktree(project.path, branch, base, dir);
      this.d.prs.create({ mission_id: missionId, branch, worktree: dir });
      log.info(`PR mode: mission ${missionId} → branch ${branch} @ ${dir}`);
    } catch (e) {
      log.error(`PR mode: failed to create worktree for mission ${missionId} — falling back to main checkout`, e);
    }
  }

  /** The worktree directory an agent for this mission should run in, or null when the mission has no
   *  PR-native worktree (disabled, or provisioning failed). Callers fall back to the project path. */
  worktreeFor(missionId: string): string | null {
    return this.d.prs.get(missionId)?.worktree ?? null;
  }

  /** Commit an approved phase's work in the mission's worktree. No-op (returns false) when PR mode is
   *  off, the mission has no worktree, or the diff is empty. */
  async commitPhase(missionId: string, phaseTitle: string): Promise<boolean> {
    if (!this.prEnabled()) return false;
    const dir = this.worktreeFor(missionId);
    if (!dir) return false;
    try {
      return await commitAll(dir, phaseTitle);
    } catch (e) {
      log.error(`PR mode: commit failed for mission ${missionId}`, e);
      return false;
    }
  }

  /** On pause/disengage: tear down the mission's worktree (the branch is kept so an open PR survives).
   *  No-op when the mission never had one. */
  async cleanup(missionId: string): Promise<void> {
    const rec = this.d.prs.get(missionId);
    if (!rec) return;
    const project = this.projectFor(missionId);
    if (project) await removeWorktree(project.path, rec.worktree);
    this.d.prs.remove(missionId);
  }
}

/** Make a slug/id safe for a git branch segment: lowercase, non-alphanumerics → single dashes. */
function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mission';
}
