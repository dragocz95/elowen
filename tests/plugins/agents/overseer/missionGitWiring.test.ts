import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { projectHead, projectRangeDiff } from '../../../../src/integrations/projectFiles.js';

// The plugin engine/scheduler take read-only git helpers as a host seam; the core functions
// stand in (the same ones the pre-extraction core imported directly).
const gitSeam = { projectHead, projectRangeDiff };
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../../../src/store/db.js';
import { TaskStore } from '../../../../src/store/taskStore.js';
import { Readiness } from '../../../../src/store/readiness.js';
import { MissionStore } from '../../../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../../../src/store/projectStore.js';
import { ConfigStore } from '../../../../src/store/configStore.js';
import { MissionPrStore } from '../../../../plugins/agents/src/store/missionPrStore.js';
import { MissionGit } from '../../../../plugins/agents/src/overseer/missionGit.js';
import { MissionEngine } from '../../../../plugins/agents/src/overseer/missionEngine.js';
import { SpawnService } from '../../../../plugins/agents/src/spawn/spawn.js';
import { FakeTmuxDriver } from '../../../../src/tmux/fakeDriver.js';
import { EventBus } from '../../../../src/api/sse.js';
import { SystemClock } from '../../../../src/shared/clock.js';

let base: string;   // unique parent so the sibling `.elowen-worktrees/` dir is isolated + cleaned
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function setup(prEnabled: boolean) {
  const db = openDb(':memory:');
  const projects = new ProjectStore(db);
  const project = projects.create({ slug: 'demo', path: repo });
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: project.id, title: 'E', type: 'epic' });
  tasks.create({ id: 't1', project_id: project.id, title: 'first phase', parent_id: 'epic' });
  const config = new ConfigStore(db);
  config.update({ autopilot: { prEnabled } });
  const prs = new MissionPrStore(db);
  const missionGit = new MissionGit({ prs, config, projects, tasks });
  const tmux = new FakeTmuxDriver();
  const launch = vi.fn().mockResolvedValue({ session: 'elowen-AgentX' });
  const engine = new MissionEngine({ git: gitSeam,
    tasks, readiness: new Readiness(db), missions: new MissionStore(db),
    spawn: { launch } as unknown as SpawnService, tmux, bus: new EventBus(),
    projects, fallback: { program: 'claude-code', model: 'sonnet' },
    nameAgent: () => 'AgentX', clock: new SystemClock(), missionGit,
  });
  return { engine, prs, launch, missionGit };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'elowen-eng-'));
  repo = join(base, 'project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@elowen.dev');
  git(repo, 'config', 'user.name', 'Elowen Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('MissionEngine × MissionGit (PR-native)', () => {
  it('engage spawns the agent inside the mission worktree when PR mode is on', async () => {
    const { engine, prs, launch } = setup(true);
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const rec = prs.get(m.id);
    expect(rec).not.toBeNull();
    expect(rec!.branch).toBe('elowen/demo-epic');
    expect(existsSync(rec!.worktree)).toBe(true);
    // The first phase agent launches with the worktree as its cwd, not the main checkout.
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ projectPath: rec!.worktree }));
  });

  it('spawns in the main checkout (no worktree) when PR mode is off', async () => {
    const { engine, prs, launch } = setup(false);
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    expect(prs.get(m.id)).toBeNull();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ projectPath: repo }));
  });

  it('disengage removes the worktree but keeps the branch', async () => {
    const { engine, prs } = setup(true);
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const dir = prs.get(m.id)!.worktree;
    await engine.disengage(m.id);
    expect(existsSync(dir)).toBe(false);
    expect(prs.get(m.id)).toBeNull();
    expect(git(repo, 'branch', '--list', 'elowen/demo-epic').trim()).toContain('elowen/demo-epic');
  });

  it('pause keeps the worktree with the running phase\'s uncommitted work, and resume reuses it', async () => {
    const { engine, prs } = setup(true);
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const dir = prs.get(m.id)!.worktree;
    // What the stopped phase's agent had produced but not yet closed — Elowen only commits at close.
    writeFileSync(join(dir, 'wip.txt'), 'work in progress\n');

    await engine.pause(m.id);
    expect(existsSync(join(dir, 'wip.txt'))).toBe(true); // pause must not destroy uncommitted work
    expect(prs.get(m.id)!.worktree).toBe(dir);

    await engine.resume(m.id);
    expect(prs.get(m.id)!.worktree).toBe(dir);          // same worktree, not a fresh one off the branch
    expect(existsSync(join(dir, 'wip.txt'))).toBe(true);
  });

  it('commitPhase records the phase work as a commit on the branch', async () => {
    const { engine, prs, missionGit } = setup(true);
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const dir = prs.get(m.id)!.worktree;
    writeFileSync(join(dir, 'feature.txt'), 'work\n');
    expect(await missionGit.commitPhase(m.id, 'first phase')).toBe(true);
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe('first phase');
  });

  it('commitPhase rejects on a git failure instead of reporting a clean tree', async () => {
    const { engine, prs, missionGit } = setup(true);
    const m = await engine.engage({ epicId: 'epic', autonomy: 'L3', maxSessions: 1 });
    const dir = prs.get(m.id)!.worktree;
    expect(await missionGit.commitPhase(m.id, 'nothing to do')).toBe(false); // clean tree → false

    writeFileSync(join(dir, 'feature.txt'), 'work\n');
    rmSync(join(dir, '.git')); // break the worktree link → every git call in it fails
    // The phase's work is still on disk and uncommitted, so this must NOT look like "clean tree".
    await expect(missionGit.commitPhase(m.id, 'first phase')).rejects.toThrow();
  });
});
