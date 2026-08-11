import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../../../src/store/db.js';
import { TaskStore } from '../../../../src/store/taskStore.js';
import { ProjectStore } from '../../../../src/store/projectStore.js';
import { ConfigStore } from '../../../../src/store/configStore.js';
import { MissionPrStore } from '../../../../plugins/agents/src/store/missionPrStore.js';
import { MissionGit } from '../../../../plugins/agents/src/overseer/missionGit.js';

let base: string, repo: string, remote: string, binDir: string, origPath: string | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function fakeGh(script: string) {
  const p = join(binDir, 'gh');
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`); chmodSync(p, 0o755);
}

function build(opts: { prAutoOpen: boolean; verify: string }) {
  const db = openDb(':memory:');
  const projects = new ProjectStore(db);
  const project = projects.create({ slug: 'demo', path: repo });
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: project.id, title: 'Build the thing', type: 'epic' });
  const config = new ConfigStore(db);
  config.update({ autopilot: { prEnabled: true, prAutoOpen: opts.prAutoOpen, prVerifyCommand: opts.verify, ghToken: 'tok' } });
  const prs = new MissionPrStore(db);
  const missionGit = new MissionGit({ prs, config, projects, tasks });
  return { missionGit, prs, tasks, projects, project };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'elowen-fin-'));
  repo = join(base, 'project'); mkdirSync(repo);
  remote = join(base, 'remote.git');
  binDir = join(base, 'bin'); mkdirSync(binDir);
  origPath = process.env.PATH; process.env.PATH = `${binDir}:${origPath}`;
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@elowen.dev'); git(repo, 'config', 'user.name', 'Elowen Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
});
afterEach(() => { process.env.PATH = origPath; rmSync(base, { recursive: true, force: true }); });

describe('MissionGit.finishMission (Stage 4)', () => {
  it('verifies, pushes and opens a PR on the happy path (auto)', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/o/r/pull/55"; fi`);
    const { missionGit, prs } = build({ prAutoOpen: true, verify: 'true' });
    await missionGit.onEngage('m-epic', 'epic');
    writeFileSync(join(prs.get('m-epic')!.worktree, 'a.txt'), 'work\n');
    await missionGit.commitPhase('m-epic', 'phase one');

    const res = await missionGit.finishMission('m-epic');
    expect(res).toEqual({ state: 'opened', url: 'https://github.com/o/r/pull/55', number: 55 });
    const rec = prs.get('m-epic')!;
    expect(rec.pr_number).toBe(55);
    expect(rec.pr_state).toBe('open');
    // The branch reached the remote.
    expect(git(remote, 'branch', '--list', 'elowen/demo-epic').trim()).toContain('elowen/demo-epic');
  });

  it('holds the mission (no PR) when the verify gate fails', async () => {
    fakeGh(`echo "should-not-run" ; exit 3`);
    const { missionGit, prs } = build({ prAutoOpen: true, verify: 'exit 1' });
    await missionGit.onEngage('m-epic', 'epic');
    writeFileSync(join(prs.get('m-epic')!.worktree, 'a.txt'), 'work\n');
    await missionGit.commitPhase('m-epic', 'phase one');

    const res = await missionGit.finishMission('m-epic');
    expect(res.state).toBe('verify-failed');
    expect(prs.get('m-epic')!.pr_state).toBe('verify_failed');
    expect(missionGit.prState('m-epic')).toBe('verify_failed');
    // No branch pushed to the remote.
    expect(git(remote, 'branch', '--list', 'elowen/demo-epic').trim()).toBe('');
  });

  it('returns ready (no PR) in manual mode, then opens it on openPr', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/o/r/pull/8"; fi`);
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic');
    writeFileSync(join(prs.get('m-epic')!.worktree, 'a.txt'), 'work\n');
    await missionGit.commitPhase('m-epic', 'phase one');

    expect((await missionGit.finishMission('m-epic')).state).toBe('ready'); // auto-open off → waits
    expect(prs.get('m-epic')!.pr_state).toBe('ready'); // persisted so the "Open PR" affordance is gated on completion

    const res = await missionGit.openPr('m-epic'); // manual trigger
    expect(res).toEqual({ state: 'opened', url: 'https://github.com/o/r/pull/8', number: 8 });
    expect(prs.get('m-epic')!.pr_state).toBe('open');
  });

  it('refuses a manual openPr while the mission is mid-flight (not yet ready)', async () => {
    // The regression: the "Open PR" affordance opened a partial PR after only the first phase. The
    // manual open must refuse until finishMission has marked the mission 'ready' (all phases done +
    // verified) — pr_state is still null here (just engaged, work in progress).
    fakeGh(`echo "should-not-create" ; exit 9`);
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic');
    writeFileSync(join(prs.get('m-epic')!.worktree, 'a.txt'), 'phase one work\n');
    await missionGit.commitPhase('m-epic', 'phase one');

    const res = await missionGit.openPr('m-epic'); // user clicks "Open PR" before the mission finished
    expect(res.state).toBe('incomplete');
    expect(prs.get('m-epic')!.pr_state).toBeNull(); // unchanged — no PR opened
    expect(git(remote, 'branch', '--list', 'elowen/demo-epic').trim()).toBe(''); // nothing pushed
  });

  it('a project pr_enabled=false suppresses the PR worktree even when the global default is on', async () => {
    const { missionGit, prs, projects, project } = build({ prAutoOpen: true, verify: '' });
    projects.update(project.id, { pr_enabled: false }); // per-project override wins over the global default
    await missionGit.onEngage('m-epic', 'epic');
    expect(prs.get('m-epic')).toBeNull(); // PR mode off for this project → no worktree provisioned
  });

  it('an epic pr:off label suppresses the worktree even when project + global are on', async () => {
    const { missionGit, prs, projects, project, tasks } = build({ prAutoOpen: true, verify: '' });
    projects.update(project.id, { pr_enabled: true }); // project on, global on…
    tasks.addLabel('epic', 'pr:off'); // …but this task opted out
    await missionGit.onEngage('m-epic', 'epic');
    expect(prs.get('m-epic')).toBeNull(); // per-task override wins → no PR worktree
  });

  it('an epic pr:on label forces the worktree even when the project override is off', async () => {
    const { missionGit, prs, projects, project, tasks } = build({ prAutoOpen: false, verify: '' });
    projects.update(project.id, { pr_enabled: false }); // project override would suppress it…
    tasks.addLabel('epic', 'pr:on'); // …but this task opted in — the most-specific override wins
    await missionGit.onEngage('m-epic', 'epic');
    expect(prs.get('m-epic')).not.toBeNull(); // per-task override wins → PR worktree provisioned
  });

  it('mergePr squash-merges an open PR and records it merged + clears the budget', async () => {
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}'; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then exit 0; fi`);
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic');
    prs.setPr('m-epic', { number: 8, url: 'https://github.com/o/r/pull/8', state: 'open' });
    prs.bumpFixRounds('m-epic'); // simulate a prior fix round

    const res = await missionGit.mergePr('m-epic');
    expect(res.ok).toBe(true);
    expect(prs.get('m-epic')!.pr_state).toBe('merged');
    expect(prs.get('m-epic')!.fix_rounds).toBe(0);
  });

  it('mergePr succeeds even when the post-merge branch delete fails (no false refusal)', async () => {
    // The regression: `gh pr merge --squash --delete-branch` exited non-zero because the branch delete
    // failed, AFTER the squash-merge had already landed — so the merge was reported as refused. Merge
    // and delete are now separate; a failing delete must not undo a successful merge.
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[],"headRefName":"elowen/demo-epic"}'; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then exit 0; fi
if [ "$1" = "api" ]; then exit 1; fi`); // the branch delete fails
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic');
    prs.setPr('m-epic', { number: 8, url: 'https://github.com/o/r/pull/8', state: 'open' });

    const res = await missionGit.mergePr('m-epic');
    expect(res.ok).toBe(true); // merge landed; the failed branch delete is best-effort
    expect(prs.get('m-epic')!.pr_state).toBe('merged');
  });

  it('mergePr refuses (no state change) when the PR has no open record', async () => {
    fakeGh(`exit 0`);
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic'); // worktree exists, but no PR opened
    const res = await missionGit.mergePr('m-epic');
    expect(res.ok).toBe(false);
    expect(prs.get('m-epic')!.pr_state).toBeNull();
  });

  it('auto-pushes a fix round onto an already-open PR even in manual mode', async () => {
    // gh create fails ("already exists") → falls back to gh pr view → the existing PR is re-read; the
    // point is finishMission must PUSH (not return ready) once a PR is open, so the fix reaches the PR.
    fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "already exists" >&2; exit 1; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":8,"url":"https://github.com/o/r/pull/8"}'; fi`);
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic');
    const wt = prs.get('m-epic')!.worktree;
    writeFileSync(join(wt, 'a.txt'), 'work\n'); await missionGit.commitPhase('m-epic', 'phase one');
    prs.setPr('m-epic', { number: 8, url: 'https://github.com/o/r/pull/8', state: 'open' }); // PR already open

    writeFileSync(join(wt, 'fix.txt'), 'the fix\n'); await missionGit.commitPhase('m-epic', 'fix round');
    const res = await missionGit.finishMission('m-epic'); // manual mode, but PR is open → must push
    expect(res.state).toBe('opened'); // NOT 'ready'
    // The fix commit reached the remote branch.
    expect(git(remote, 'log', '--oneline', 'elowen/demo-epic').trim()).toContain('fix round');
  });
});

describe('MissionGit worktree placement', () => {
  // The mission id is `m-${epicId}` and an epic id can be client-supplied, so it reaches this path as
  // untrusted input. Unsanitized it escapes the worktree root — and since cleanup runs
  // `git worktree remove --force` on whatever it finds there, an escape is a delete primitive, not just
  // a stray directory. The API schema rejects such an id too; this covers the inner layer, which has to
  // hold for any id that reaches the engine by another route.
  it('keeps a traversal-shaped epic id inside the worktree root', async () => {
    const { missionGit, prs, tasks, project } = build({ prAutoOpen: false, verify: 'true' });
    const evilId = '../../../../tmp/elowen-escape-probe';
    tasks.create({ id: evilId, project_id: project.id, title: 'Traversal probe', type: 'epic' });

    await missionGit.onEngage(`m-${evilId}`, evilId);

    const rec = prs.get(`m-${evilId}`);
    expect(rec, 'the mission should still be provisioned, just somewhere safe').toBeTruthy();
    const root = resolve(join(base, '.elowen-worktrees'));
    expect(resolve(rec!.worktree).startsWith(`${root}/`)).toBe(true);
    expect(rec!.worktree).not.toContain('..');
  });
});
