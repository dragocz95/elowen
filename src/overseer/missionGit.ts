import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MissionPrStore } from '../store/missionPrStore.js';
import type { ConfigStore } from '../store/configStore.js';
import type { TaskStore } from '../store/taskStore.js';
import { logger } from '../shared/logger.js';
import { createMissionWorktree, removeWorktree, commitAll, pushBranch, detectBaseBranch } from '../integrations/git/worktree.js';
import { createPR, readPRReviews, mergePR, type MergeResult } from '../integrations/github/pr.js';

const run = promisify(execFile);
const log = logger('mission-git');

/** Outcome of finalising a mission's git work at epic-done (or a manual PR open). */
export type FinishResult =
  | { state: 'off' }                                   // PR mode off / no worktree → nothing to do
  | { state: 'verify-failed'; output: string }         // the verify gate failed → mission held, no PR
  | { state: 'ready' }                                  // verified, awaiting a manual "Open PR"
  | { state: 'no-remote' }                              // no origin remote → couldn't push
  | { state: 'pr-failed' }                              // gh missing/unauthenticated → PR not opened
  | { state: 'opened'; url: string; number: number };   // PR opened (or an existing one re-read)

export interface MissionGitDeps {
  prs: MissionPrStore;
  config: ConfigStore;
  projects: { get(id: number): { id: number; slug: string; path: string } | null };
  tasks: TaskStore;
}

/** Outcome of polling a PR for new review feedback. ingestReviews only DETECTS — turning feedback into
 *  fix phases is the caller's job (it routes through the pilot, or a single-phase fallback). */
export type IngestResult =
  | { action: 'none' }                                                  // no PR / no fresh actionable feedback
  | { action: 'closed' }                                                // PR merged/closed → stop watching
  | { action: 'feedback'; feedback: string; newestTs: string; exec?: string }; // fresh feedback to plan a fix from

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

  /** The recorded PR lifecycle state for a mission (open|merged|closed|verify_failed), or null when it
   *  has no PR record / mode is off. Lets the engine short-circuit a completed-but-held mission without
   *  re-running the verify gate every tick. */
  prState(missionId: string): string | null {
    return this.d.prs.get(missionId)?.pr_state ?? null;
  }

  /** Branch + PR metadata for the mission, for the web UI (badge, link, "Open PR" affordance). Null
   *  when the mission has no PR-native record (mode off / not engaged in PR mode). */
  prInfo(missionId: string): { branch: string; prNumber: number | null; prUrl: string | null; prState: string | null; fixRounds: number; lastFeedback: string | null } | null {
    const rec = this.d.prs.get(missionId);
    return rec ? { branch: rec.branch, prNumber: rec.pr_number, prUrl: rec.pr_url, prState: rec.pr_state, fixRounds: rec.fix_rounds, lastFeedback: rec.last_feedback } : null;
  }

  /** Mission ids with a PR still needing attention (no PR yet, or an open one) — used so a completed
   *  mission keeps showing its branch/PR affordance in the UI even after it has disengaged. */
  pendingPrMissionIds(): string[] {
    return this.d.prs.pending().map((r) => r.mission_id);
  }

  /** Squash-merge the mission's open PR into the base branch (the manual "Merge to main" affordance).
   *  Delegates the open/conflict/CI gate to `mergePR` and, on success, records the PR as merged and
   *  clears the fix budget. Returns the refusal reason so the UI can explain a blocked merge. */
  async mergePr(missionId: string): Promise<MergeResult> {
    if (!this.prEnabled()) return { ok: false, reason: 'PR workflow not enabled' };
    const rec = this.d.prs.get(missionId);
    if (!rec || rec.pr_number == null || rec.pr_state !== 'open') return { ok: false, reason: 'no open PR for this mission' };
    const res = await mergePR({ dir: rec.worktree, number: rec.pr_number, token: this.d.config.ghToken() ?? '' });
    if (res.ok) {
      this.d.prs.setPrState(missionId, 'merged');
      this.d.prs.resetFixRounds(missionId);
      log.info(`PR mode: mission ${missionId} PR #${rec.pr_number} merged`);
    }
    return res;
  }

  /** Finalise a mission at epic-done: run the verify gate, then (when auto-open is on) push the branch
   *  and open the PR. With auto-open off, a passing gate returns 'ready' and waits for a manual open.
   *  A failing gate records 'verify_failed' and opens nothing. No-op when PR mode is off. */
  async finishMission(missionId: string): Promise<FinishResult> {
    return this.finalize(missionId, false);
  }

  /** Manual "Open PR": same verify gate, then always push + open regardless of the auto-open setting. */
  async openPr(missionId: string): Promise<FinishResult> {
    return this.finalize(missionId, true);
  }

  private async finalize(missionId: string, force: boolean): Promise<FinishResult> {
    if (!this.prEnabled()) return { state: 'off' };
    const rec = this.d.prs.get(missionId);
    const project = this.projectFor(missionId);
    if (!rec || !project) return { state: 'off' };
    const cfg = this.d.config.get().autopilot;
    // Verify gate: a configured command must exit 0 in the worktree before any PR opens.
    if (cfg.prVerifyCommand.trim()) {
      const v = await this.runVerify(rec.worktree, cfg.prVerifyCommand);
      if (!v.ok) {
        this.d.prs.setPrState(missionId, 'verify_failed');
        log.warn(`PR mode: verify gate failed for mission ${missionId} — holding, no PR`);
        return { state: 'verify-failed', output: v.output };
      }
    }
    // prAutoOpen gates only the FIRST open. Once a PR exists, a completed fix round must always push so
    // the PR reflects the new commits — otherwise the feedback loop commits a fix nobody ever sees.
    const prAlreadyOpen = rec.pr_state === 'open';
    if (!force && !prAlreadyOpen && !cfg.prAutoOpen) return { state: 'ready' }; // verified, waiting for a manual open
    return this.pushAndOpen(missionId, rec.worktree, rec.branch, project.path, cfg.prBaseBranch);
  }

  private async pushAndOpen(missionId: string, worktree: string, branch: string, repoPath: string, configuredBase: string): Promise<FinishResult> {
    const token = this.d.config.ghToken() ?? '';
    let pushed = false;
    try { pushed = await pushBranch(worktree, branch, token); }
    catch (e) { log.error(`PR mode: push failed for ${branch}`, e); return { state: 'no-remote' }; }
    if (!pushed) return { state: 'no-remote' };
    const base = await detectBaseBranch(repoPath, configuredBase);
    const epic = this.d.tasks.get(missionId.replace(/^m-/, ''));
    const title = epic?.title ?? branch;
    const body = epic?.result_summary?.trim() || 'Opened by Orca autopilot.';
    const pr = await createPR({ dir: worktree, base, head: branch, title, body, token });
    if (!pr) return { state: 'pr-failed' };
    this.d.prs.setPr(missionId, { number: pr.number, url: pr.url, state: 'open' });
    log.info(`PR mode: mission ${missionId} → PR #${pr.number} ${pr.url}`);
    return { state: 'opened', url: pr.url, number: pr.number };
  }

  /** Run the admin-configured verify command in the worktree via `sh -c`. The command is set by an
   *  admin in Settings (like a CI step), so the shell is intentional; it never carries agent/user input.
   *  Returns ok + combined output (output truncated for the escalation event). */
  private async runVerify(dir: string, command: string): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await run('sh', ['-c', command], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, output: `${stdout}${stderr}`.slice(-4000) };
    } catch (e) {
      const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
      return { ok: false, output: (out || String(e)).slice(-4000) };
    }
  }

  /** Poll the mission's open PR for fresh, actionable review feedback. A merged/closed PR stops the
   *  watch (and clears the fix budget). Otherwise it gathers everything newer than the last ingested
   *  timestamp and, if any is *actionable*, returns the aggregated text plus the original mission's exec
   *  (so fix phases inherit the same model) for the caller to plan a fix from. Actionable = a
   *  CHANGES_REQUESTED review, a line-level (diff) comment, a COMMENTED review with a real body, or a
   *  conversation comment — a bare 👍/empty review is ignored. Dedup is by `last_review_ts`, which is
   *  advanced here whenever feedback is returned so the same batch is never planned twice. No-op when PR
   *  mode is off. */
  async ingestReviews(missionId: string): Promise<IngestResult> {
    if (!this.prEnabled()) return { action: 'none' };
    const rec = this.d.prs.get(missionId);
    if (!rec || rec.pr_number == null || rec.pr_state !== 'open') return { action: 'none' };
    const project = this.projectFor(missionId);
    if (!project) return { action: 'none' };
    const status = await readPRReviews({ dir: rec.worktree, number: rec.pr_number, token: this.d.config.ghToken() ?? '' });
    if (!status) return { action: 'none' };
    if (status.state === 'MERGED' || status.state === 'CLOSED') {
      this.d.prs.setPrState(missionId, status.state.toLowerCase());
      this.d.prs.resetFixRounds(missionId);
      log.info(`PR mode: mission ${missionId} PR is ${status.state.toLowerCase()} — no longer watching`);
      return { action: 'closed' };
    }
    const since = rec.last_review_ts ? Date.parse(rec.last_review_ts) : 0;
    const ts = (s: string): number => Date.parse(s) || 0;
    const freshReviews = status.reviews.filter((r) => ts(r.submittedAt) > since
      && (r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body.trim().length > 0)));
    const freshLines = status.lineComments.filter((c) => ts(c.createdAt) > since && c.body.trim().length > 0);
    const freshComments = status.comments.filter((c) => ts(c.createdAt) > since && c.body.trim().length > 0);
    if (freshReviews.length + freshLines.length + freshComments.length === 0) return { action: 'none' };

    const newestMs = [...freshReviews.map((r) => ts(r.submittedAt)), ...freshLines.map((c) => ts(c.createdAt)), ...freshComments.map((c) => ts(c.createdAt))]
      .reduce((mx, n) => Math.max(mx, n), since);
    const feedback = [
      ...freshReviews.map((r) => `- ${r.author || 'reviewer'} (${r.state}): ${r.body.trim() || '(no summary)'}`),
      ...freshLines.map((c) => `- ${c.author || 'reviewer'} @ ${c.path}:${c.line ?? '?'}: ${c.body.trim()}`),
      ...freshComments.map((c) => `- ${c.author || 'reviewer'}: ${c.body.trim()}`),
    ].join('\n');
    const exec = this.missionExec(project.id, missionId.replace(/^m-/, ''));
    this.d.prs.setLastReviewTs(missionId, new Date(newestMs).toISOString());
    this.d.prs.setLastFeedback(missionId, feedback); // surfaced in the UI so the fix round is explained

    log.info(`PR mode: mission ${missionId} got ${freshReviews.length + freshLines.length + freshComments.length} fresh feedback item(s)`);
    return { action: 'feedback', feedback, newestTs: new Date(newestMs).toISOString(), exec };
  }

  /** Relay-only fallback (no agent pilot configured): append a single fix phase under the epic instead
   *  of planning 1..N via the pilot. Depends on the epic's last phase so it runs last; inherits `exec`.
   *  Deterministic id keyed on the fix-round index so re-sweeps before the bump don't double-create.
   *  Returns true when a phase was appended. */
  async appendFixPhase(epicId: string, feedback: string, exec?: string): Promise<boolean> {
    const epic = this.d.tasks.get(epicId);
    const project = epic ? this.d.projects.get(epic.project_id) : null;
    if (!project) return false;
    const children = this.d.tasks.list({ project_id: project.id }).filter((t) => t.parent_id === epicId);
    const fixId = `${epicId}-prfix-${this.d.prs.get(`m-${epicId}`)?.fix_rounds ?? 0}`;
    if (this.d.tasks.get(fixId)) return false; // already appended for this round
    this.d.tasks.create({
      id: fixId, project_id: project.id, title: 'Address PR review feedback', parent_id: epicId,
      description: `A reviewer left feedback on the open pull request. Apply the requested fixes in the working tree (do not touch git/branches — Orca commits and pushes for you):\n\n${feedback}`,
    });
    const lastPhase = children[children.length - 1] ?? null;
    if (lastPhase) this.d.tasks.addDep(fixId, lastPhase.id);
    if (exec) this.d.tasks.setExec(fixId, exec);
    return true;
  }

  /** The exec the original mission's phases ran on, read from the `exec:<spec>` label of the epic's last
   *  labelled phase, so fix phases inherit the same model instead of the hard-wired sonnet fallback.
   *  Undefined when no phase carried an exec (then the fallback applies — same as the original run). */
  private missionExec(projectId: number, epicId: string): string | undefined {
    const children = this.d.tasks.list({ project_id: projectId }).filter((t) => t.parent_id === epicId);
    for (let i = children.length - 1; i >= 0; i--) {
      const label = children[i]?.labels.find((l) => l.startsWith('exec:'));
      if (label) return label.slice('exec:'.length);
    }
    return undefined;
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
