import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { MissionPrStore } from '../../src/store/missionPrStore.js';
import { MissionGit } from '../../src/overseer/missionGit.js';
import { createServer } from '../../src/api/server.js';
import { EventBus } from '../../src/api/sse.js';
import { SystemClock } from '../../src/shared/clock.js';

let base: string, repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const close = (app: ReturnType<typeof createServer>, id: string) =>
  app.request(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', result_summary: 'done', outcome: 'ok' }) });

function build(prEnabled: boolean) {
  const db = openDb(':memory:');
  const projects = new ProjectStore(db);
  const project = projects.create({ slug: 'demo', path: repo });
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: project.id, title: 'E', type: 'epic' });
  tasks.create({ id: 'p1', project_id: project.id, title: 'first phase', parent_id: 'epic' });
  const missions = new MissionStore(db);
  missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
  const config = new ConfigStore(db);
  config.update({ autopilot: { prEnabled } });
  const prs = new MissionPrStore(db);
  const missionGit = new MissionGit({ prs, config, projects, tasks });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions, engine: { tick: async () => {}, isActive: () => false } as never,
    spawn: null as never, tmux: null as never, bus: new EventBus(), missionGit, projects,
    project: { id: project.id, path: repo }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new SystemClock(), config,
  });
  return { app, missionGit, prs };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-pc-'));
  repo = join(base, 'project'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@orca.dev'); git(repo, 'config', 'user.name', 'Orca Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('phase commit on close (PR-native)', () => {
  it('commits the phase worktree work when the phase closes', async () => {
    const { app, missionGit, prs } = build(true);
    await missionGit.onEngage('m-epic', 'epic');
    const dir = prs.get('m-epic')!.worktree;
    writeFileSync(join(dir, 'feature.txt'), 'work\n');     // agent's uncommitted phase output

    expect((await close(app, 'p1')).status).toBe(200);
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe('first phase');
  });

  it('does not commit when PR mode is off (no worktree at all)', async () => {
    const { app, prs } = build(false);
    expect(prs.get('m-epic')).toBeNull();              // no worktree provisioned
    expect((await close(app, 'p1')).status).toBe(200); // close still succeeds, just no commit side-effect
  });
});
