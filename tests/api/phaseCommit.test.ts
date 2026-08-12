import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { agentsPluginConfig } from '../../plugins/agents/src/config.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { MissionPrStore } from '../../plugins/agents/src/store/missionPrStore.js';
import { MissionGit } from '../../plugins/agents/src/overseer/missionGit.js';
import { createReviewService } from '../../plugins/agents/src/overseer/reviewService.js';
import { DecisionQueue } from '../../plugins/agents/src/overseer/decisionQueue.js';
import { KeyedMutex } from '../../plugins/agents/src/lib/keyedMutex.js';
import { projectHead, projectRangeDiff } from '../../src/integrations/projectFiles.js';
import { createServer } from '../../src/api/server.js';
import { EventBus } from '../../src/api/sse.js';
import { SystemClock } from '../../src/shared/clock.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

let base: string, repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const close = (app: ReturnType<typeof createServer>, id: string) =>
  app.request(`/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', result_summary: 'done', outcome: 'ok' }) });

function build(prEnabled: boolean) {
  const db = openAgentsDb(':memory:');
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
  const missionGit = new MissionGit({ prs, pluginConfig: () => agentsPluginConfig({}, config as never), projects, tasks });
  const bus = new EventBus();
  // The phase commit lives in the agents plugin's review service now — wire its onTaskClosed into the
  // server exactly like bootstrap does through the 'agents' control.
  const review = createReviewService({
    tasks, taskRefs: new TaskRefs(db), missions, pluginConfig: () => agentsPluginConfig({}, config as never), decisionQueue: new DecisionQueue(), gitLock: new KeyedMutex(),
    git: { projectHead, projectRangeDiff }, missionGit,
    engine: { resumeStalled: async () => {}, stopTask: async () => {}, tick: async () => {} },
    publish: (e) => bus.publish(e), pathFor: (pid) => projects.get(pid)?.path ?? repo,
  });
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), readiness: new Readiness(db), missions, engine: { tick: async () => {}, isActive: () => false } as never,
    spawn: null as never, tmux: null as never, bus, missionGit, projects,
    onTaskClosed: review.onTaskClosed,
    project: { id: project.id, path: repo }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new SystemClock(), config,
  });
  return { app, missionGit, prs, tasks };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'elowen-pc-'));
  repo = join(base, 'project'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@elowen.dev'); git(repo, 'config', 'user.name', 'Elowen Test');
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

  it('a failed phase commit does not freeze an empty change snapshot', async () => {
    const { app, missionGit, prs, tasks } = build(true);
    await missionGit.onEngage('m-epic', 'epic');
    const dir = prs.get('m-epic')!.worktree;
    tasks.markBase('p1', git(repo, 'rev-parse', 'HEAD').trim()); // spawn-time baseline, as the engine stamps it
    writeFileSync(join(dir, 'feature.txt'), 'work\n');           // real, uncommitted phase output
    // Hold the worktree's index lock: `git add -A` fails, while the repo stays perfectly readable — so
    // the snapshot below would happily record a (wrong, empty) base..HEAD change list.
    writeFileSync(join(repo, '.git', 'worktrees', basename(dir), 'index.lock'), '');

    expect((await close(app, 'p1')).status).toBe(200); // the close itself must still succeed
    // The work never landed, so the task must NOT carry a snapshot claiming it changed nothing.
    expect(tasks.get('p1')!.head_sha).toBeNull();
  });
});
