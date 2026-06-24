import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { MissionPrStore } from '../../src/store/missionPrStore.js';
import { MissionGit } from '../../src/overseer/missionGit.js';
import { sweepPrFeedback } from '../../src/overseer/prFeedback.js';

let base: string, repo: string, binDir: string, origPath: string | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const fakeGh = (script: string) => { const p = join(binDir, 'gh'); writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`); chmodSync(p, 0o755); };

// gh stub: `pr view` returns lifecycle+reviews+conversation, `api` returns line comments. Each helper
// fills the bits a test cares about; the `api` branch defaults to an empty array unless overridden.
const ghReview = (viewJson: string, apiJson = '[]') => fakeGh(`
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '${viewJson}'
elif [ "$1" = "api" ]; then
  echo '${apiJson}'
fi`);
const ghChangesRequested = (ts: string) =>
  ghReview(`{"state":"OPEN","reviews":[{"state":"CHANGES_REQUESTED","body":"please rename the function","submittedAt":"${ts}","author":{"login":"alice"}}],"comments":[]}`);

async function build(opts: { exec?: string } = {}) {
  const db = openDb(':memory:');
  const projects = new ProjectStore(db);
  const project = projects.create({ slug: 'demo', path: repo });
  const tasks = new TaskStore(db);
  tasks.create({ id: 'epic', project_id: project.id, title: 'E', type: 'epic' });
  tasks.create({ id: 'p1', project_id: project.id, title: 'first phase', parent_id: 'epic' });
  if (opts.exec) tasks.setExec('p1', opts.exec);
  const config = new ConfigStore(db);
  config.update({ autopilot: { prEnabled: true, ghToken: 'tok' } });
  const prs = new MissionPrStore(db);
  const missions = new MissionStore(db);
  missions.create({ id: 'm-epic', epic_id: 'epic', autonomy: 'L3', max_sessions: 1 });
  const missionGit = new MissionGit({ prs, config, projects, tasks });
  await missionGit.onEngage('m-epic', 'epic');
  prs.setPr('m-epic', { number: 12, url: 'https://github.com/o/r/pull/12', state: 'open' }); // simulate an opened PR
  return { missionGit, prs, tasks, missions, projects };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-fb-'));
  repo = join(base, 'project'); mkdirSync(repo);
  binDir = join(base, 'bin'); mkdirSync(binDir);
  origPath = process.env.PATH; process.env.PATH = `${binDir}:${origPath}`;
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@orca.dev'); git(repo, 'config', 'user.name', 'Orca Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => { process.env.PATH = origPath; rmSync(base, { recursive: true, force: true }); });

describe('MissionGit.ingestReviews (detector)', () => {
  it('returns aggregated feedback for a changes-requested review', async () => {
    ghChangesRequested('2026-06-24T10:00:00Z');
    const { missionGit } = await build();
    const res = await missionGit.ingestReviews('m-epic');
    expect(res.action).toBe('feedback');
    expect((res as { feedback: string }).feedback).toContain('please rename the function');
  });

  it('triggers on a COMMENTED review that carries a line comment (Codex bot case)', async () => {
    ghReview(
      `{"state":"OPEN","reviews":[{"state":"COMMENTED","body":"Codex review","submittedAt":"2026-06-24T10:00:00Z","author":{"login":"codex[bot]"}}],"comments":[]}`,
      `[{"body":"windowHours cap bug","path":"web/x.tsx","line":298,"user":{"login":"codex[bot]"},"created_at":"2026-06-24T10:00:05Z"}]`,
    );
    const { missionGit } = await build();
    const res = await missionGit.ingestReviews('m-epic');
    expect(res.action).toBe('feedback');
    expect((res as { feedback: string }).feedback).toContain('web/x.tsx:298');
    expect((res as { feedback: string }).feedback).toContain('windowHours cap bug');
  });

  it('ignores a bare COMMENTED review with no body and no line comments', async () => {
    ghReview(`{"state":"OPEN","reviews":[{"state":"COMMENTED","body":"","submittedAt":"2026-06-24T10:00:00Z","author":{"login":"codex[bot]"}}],"comments":[]}`);
    const { missionGit } = await build();
    expect((await missionGit.ingestReviews('m-epic')).action).toBe('none');
  });

  it('inherits the original mission exec from the epic phases', async () => {
    ghChangesRequested('2026-06-24T10:00:00Z');
    const { missionGit } = await build({ exec: 'codex:gpt-5.5' });
    const res = await missionGit.ingestReviews('m-epic');
    expect((res as { exec?: string }).exec).toBe('codex:gpt-5.5');
  });

  it('dedups the same review batch via last_review_ts', async () => {
    ghChangesRequested('2026-06-24T10:00:00Z');
    const { missionGit } = await build();
    expect((await missionGit.ingestReviews('m-epic')).action).toBe('feedback');
    expect((await missionGit.ingestReviews('m-epic')).action).toBe('none'); // same timestamp → already ingested
  });

  it('stops watching and clears the budget when the PR is merged', async () => {
    ghReview(`{"state":"MERGED","reviews":[],"comments":[]}`);
    const { missionGit, prs } = await build();
    prs.bumpFixRounds('m-epic');
    const res = await missionGit.ingestReviews('m-epic');
    expect(res.action).toBe('closed');
    expect(prs.get('m-epic')!.pr_state).toBe('merged');
    expect(prs.get('m-epic')!.fix_rounds).toBe(0);
    expect(prs.withOpenPr()).toHaveLength(0);
  });
});

describe('sweepPrFeedback (budget + replan)', () => {
  const deps = (over: Record<string, unknown>) => ({
    replan: vi.fn().mockResolvedValue(true),
    bus: { publish: vi.fn() },
    ...over,
  });

  it('replans on fresh feedback (passing the inherited exec) and spends a budget round', async () => {
    ghChangesRequested('2026-06-24T10:00:00Z');
    const { missionGit, prs, missions, projects } = await build({ exec: 'codex:gpt-5.5' });
    const d = deps({ prs, missions, missionGit, projects });
    const ids = await sweepPrFeedback(d as never);
    expect(ids).toEqual(['m-epic']);
    expect(d.replan).toHaveBeenCalledWith(expect.objectContaining({ epicId: 'epic', exec: 'codex:gpt-5.5' }));
    expect(prs.get('m-epic')!.fix_rounds).toBe(1); // replan owns re-engage (via the plan job's engage flag)
  });

  it('does not spend a budget round when replan fails to start (e.g. no pilot)', async () => {
    ghChangesRequested('2026-06-24T10:00:00Z');
    const { missionGit, prs, missions, projects } = await build();
    const d = deps({ prs, missions, missionGit, projects, replan: vi.fn().mockResolvedValue(false) });
    expect(await sweepPrFeedback(d as never)).toEqual([]);
    expect(prs.get('m-epic')!.fix_rounds).toBe(0);
  });

  it('escalates to stalled (no replan) once the fix budget is exhausted', async () => {
    ghChangesRequested('2026-06-24T10:00:00Z');
    const { missionGit, prs, missions, projects } = await build();
    prs.bumpFixRounds('m-epic'); prs.bumpFixRounds('m-epic'); // already at the budget of 2
    const d = deps({ prs, missions, missionGit, projects });
    const ids = await sweepPrFeedback(d as never);
    expect(ids).toEqual([]);
    expect(d.replan).not.toHaveBeenCalled();
    expect(missions.get('m-epic')!.state).toBe('stalled');
    expect(d.bus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'mission', missionId: 'm-epic', state: 'stalled' }));
  });

  it('does nothing when there is no fresh feedback', async () => {
    ghReview(`{"state":"OPEN","reviews":[],"comments":[]}`);
    const { missionGit, prs, missions, projects } = await build();
    const d = deps({ prs, missions, missionGit, projects });
    expect(await sweepPrFeedback(d as never)).toEqual([]);
    expect(d.replan).not.toHaveBeenCalled();
  });
});
