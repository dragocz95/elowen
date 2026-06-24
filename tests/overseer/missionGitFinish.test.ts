import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { MissionPrStore } from '../../src/store/missionPrStore.js';
import { MissionGit } from '../../src/overseer/missionGit.js';

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
  return { missionGit, prs, tasks };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-fin-'));
  repo = join(base, 'project'); mkdirSync(repo);
  remote = join(base, 'remote.git');
  binDir = join(base, 'bin'); mkdirSync(binDir);
  origPath = process.env.PATH; process.env.PATH = `${binDir}:${origPath}`;
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@orca.dev'); git(repo, 'config', 'user.name', 'Orca Test');
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
    expect(git(remote, 'branch', '--list', 'orca/demo-epic').trim()).toContain('orca/demo-epic');
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
    expect(git(remote, 'branch', '--list', 'orca/demo-epic').trim()).toBe('');
  });

  it('returns ready (no PR) in manual mode, then opens it on openPr', async () => {
    fakeGh(`if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/o/r/pull/8"; fi`);
    const { missionGit, prs } = build({ prAutoOpen: false, verify: '' });
    await missionGit.onEngage('m-epic', 'epic');
    writeFileSync(join(prs.get('m-epic')!.worktree, 'a.txt'), 'work\n');
    await missionGit.commitPhase('m-epic', 'phase one');

    expect((await missionGit.finishMission('m-epic')).state).toBe('ready'); // auto-open off → waits
    expect(prs.get('m-epic')!.pr_state).toBeNull();

    const res = await missionGit.openPr('m-epic'); // manual trigger
    expect(res).toEqual({ state: 'opened', url: 'https://github.com/o/r/pull/8', number: 8 });
    expect(prs.get('m-epic')!.pr_state).toBe('open');
  });
});
