import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { EventBus } from '../../src/api/sse.js';
import { FakeClock } from '../../src/shared/clock.js';
import { createServer } from '../../src/api/server.js';
import { resetManagedBranchCache } from '../../src/api/routes/projects.js';
import { managedGuestRoot } from '../../src/shared/projectExecution.js';

/** The branch a managed project's card shows.
 *
 *  A managed project has no host path, so the register cannot read its `.git/HEAD` the way it reads a
 *  host worktree's. It goes through the SAME seam `/projects/:id/git` uses — the environment provider's
 *  state read, then git run inside the guest under the caller's identity — and the whole point of the
 *  cases below is that the seam's failure modes stay apart: a container that is cold, a directory that is
 *  not a repository and a guest that broke are three different things, and none of them may become a
 *  fabricated branch or take the rest of the register down with it. */

const databases: Db[] = [];
const roots: string[] = [];
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

interface Recorded { projectId: number; accountUserId: number; cwd: string }

/** A provider that answers the register exactly as Sandbox does: an environment state read, then a
 *  prepared execution the daemon launches itself. `script` stands in for the guest's git — the shapes are
 *  the provider contract, and what runs is a real child process, so the reader's parsing and its strict
 *  recovery are exercised rather than mocked away. */
function provider(options: {
  state?: 'running' | 'stopped' | 'unprovisioned';
  script?: string;
  scriptFor?: (projectId: number) => string;
  stateFails?: boolean;
}) {
  const launchRoot = mkdtempSync(join(tmpdir(), 'elowen-guest-'));
  roots.push(launchRoot);
  const environmentReads: Recorded[] = [];
  const executions: Recorded[] = [];
  let live = 0;
  let peakConcurrency = 0;
  return {
    environmentReads,
    executions,
    peak: () => peakConcurrency,
    control: {
      environmentFor: async ({ project, accountUserId }: { project: { projectId: number }; accountUserId: number }) => {
        environmentReads.push({ projectId: project.projectId, accountUserId, cwd: '' });
        if (options.stateFails) throw new Error('provider unavailable');
        return { projectId: project.projectId, generation: 1, state: options.state ?? 'running' };
      },
      prepareExecution: async (
        { projectRef, command, cwd }: { projectRef: { kind: string; projectId: number }; command: { type: string; file: string; args: string[] }; cwd: string },
        { accountUserId }: { accountUserId: number },
      ) => {
        executions.push({ projectId: projectRef.projectId, accountUserId, cwd });
        live += 1;
        peakConcurrency = Math.max(peakConcurrency, live);
        const script = options.scriptFor?.(projectRef.projectId) ?? options.script ?? "printf 'feat/managed\\nabc1234\\n'";
        return {
          mode: 'managed' as const,
          projectRef,
          // The provider names the directory the command actually launches in; the guest root the caller
          // asked for is recorded above and asserted on.
          cwd: launchRoot,
          launch: { type: 'argv' as const, file: '/bin/sh', args: ['-c', script], env: process.env },
          cancel: async () => {},
          lease: { heartbeat: async () => {}, release: async () => { live -= 1; } },
          sanitizeOutput: (value: string) => value,
          command,
        };
      },
    },
  };
}

function setup(sandbox?: Record<string, unknown>, projects?: { slug: string; path?: string; managed?: boolean }[]) {
  const db = openDb(':memory:');
  databases.push(db);
  const users = new UserStore(db);
  const store = new ProjectStore(db);
  const userProjects = new UserProjectStore(db);
  const admin = users.create('admin', 'test-password');
  // A managed row is only ever written by the store's own managed path, which is where its ceiling is
  // enforced; an administrator is unbounded, so the fixture creates them as one.
  const created = (projects ?? [{ slug: 'atelier', managed: true }]).map((spec) => spec.managed
    ? store.createForUser(admin.id, { slug: spec.slug })
    : store.create({ slug: spec.slug, path: spec.path ?? '/srv/none' }));
  const plugins = sandbox
    ? { get: async () => ({ control: (name: string) => name === 'sandbox' ? sandbox : undefined }) } as never
    : undefined;
  const app = createServer({
    bus: new EventBus(), engine: null as never, spawn: null as never, tmux: null as never,
    project: created[0]!, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users, projects: store, userProjects, plugins,
  });
  return { app, users, store, created, adminToken: users.issueToken(admin.id) };
}

const summaryOf = async (app: { request: (path: string, init?: unknown) => Promise<Response> }, token: string) =>
  await (await app.request('/projects/summary', auth(token))).json() as { projectId: number; branch?: string }[];

afterEach(() => {
  resetManagedBranchCache();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the project register branch for a managed project', () => {
  it('reads it through the provider seam, under the caller identity and at the project guest root', async () => {
    const fake = provider({});
    const { app, created, adminToken } = setup(fake.control);
    const project = created[0]!;

    expect((await summaryOf(app, adminToken))[0]).toMatchObject({ projectId: project.id, branch: 'feat/managed' });
    // The state read comes first and costs one database call; only a RUNNING environment is asked to run
    // anything, and both halves carry the caller's own account rather than the daemon's.
    expect(fake.environmentReads).toEqual([{ projectId: project.id, accountUserId: 1, cwd: '' }]);
    expect(fake.executions).toEqual([{ projectId: project.id, accountUserId: 1, cwd: managedGuestRoot(project.slug, project.id) }]);
  });

  it('reports the short commit for a detached head', async () => {
    const fake = provider({ script: "printf 'HEAD\\ndeadbee\\n'" });
    const { app, adminToken } = setup(fake.control);
    expect((await summaryOf(app, adminToken))[0]!.branch).toBe('deadbee');
  });

  // A cold container is not a repository verdict. Nothing may start it to find out, and nothing may
  // invent a branch for it.
  it('asks a container that is not running for nothing, and reports no branch', async () => {
    const fake = provider({ state: 'stopped' });
    const { app, adminToken } = setup(fake.control);
    const summary = await summaryOf(app, adminToken);

    expect(summary[0]).not.toHaveProperty('branch');
    expect(fake.environmentReads).toHaveLength(1);
    expect(fake.executions, 'a stopped environment is never executed in').toEqual([]);
  });

  it('reports no branch when the guest directory is not a repository', async () => {
    const fake = provider({ script: "echo 'fatal: not a git repository (or any of the parent directories): .git' >&2; exit 128" });
    const { app, adminToken } = setup(fake.control);
    expect((await summaryOf(app, adminToken))[0]).not.toHaveProperty('branch');
  });

  it('reports no branch when there is no provider at all', async () => {
    const { app, adminToken } = setup(undefined);
    expect((await summaryOf(app, adminToken))[0]).not.toHaveProperty('branch');
  });

  it('survives a state read the provider refuses', async () => {
    const fake = provider({ stateFails: true });
    const { app, adminToken } = setup(fake.control);
    const summary = await summaryOf(app, adminToken);
    expect(summary).toHaveLength(1);
    expect(summary[0]).not.toHaveProperty('branch');
  });

  // THE register invariant: one project's guest is one project's problem. A broken container used to be
  // the only way a whole list read could fail, and a register that renders nothing because one of six
  // environments is wedged is worse than six cards with one missing branch.
  it('keeps every other card when one managed guest fails outright', async () => {
    const fake = provider({
      // Exit 127 is a launcher failure, not git's verdict: strict recovery must rethrow it rather than
      // degrade it into "not a repository".
      scriptFor: (projectId) => projectId === 2 ? 'exit 127' : "printf 'main\\nabc1234\\n'",
    });
    const { app, created, adminToken } = setup(fake.control, [
      { slug: 'alpha', managed: true }, { slug: 'beta', managed: true }, { slug: 'gamma', managed: true },
    ]);
    const summary = await summaryOf(app, adminToken);

    expect(summary).toHaveLength(3);
    const byId = new Map(summary.map((entry) => [entry.projectId, entry.branch]));
    expect(byId.get(created[1]!.id)).toBeUndefined();
    expect(byId.get(created[0]!.id)).toBe('main');
    expect(byId.get(created[2]!.id)).toBe('main');
  });

  it('mixes a host worktree and a managed guest in one answer', async () => {
    const fake = provider({});
    const { app, created, adminToken } = setup(fake.control, [
      { slug: 'atelier', managed: true }, { slug: 'plain', path: join(tmpdir(), 'elowen-not-a-repo') },
    ]);
    const summary = await summaryOf(app, adminToken);
    expect(summary.find((entry) => entry.projectId === created[0]!.id)!.branch).toBe('feat/managed');
    // The host project is not a repository, and it says so by carrying no branch — the two paths agree
    // on what "nothing to report" looks like.
    expect(summary.find((entry) => entry.projectId === created[1]!.id)).not.toHaveProperty('branch');
  });

  // A register of many managed projects must not open many guest leases at once, and must not hold the
  // response behind an unbounded fan-out.
  it('bounds how many guests it holds open at a time', async () => {
    const fake = provider({ script: "sleep 0.05; printf 'main\\nabc1234\\n'" });
    const { app, adminToken } = setup(fake.control, Array.from({ length: 12 }, (_, index) => ({ slug: `p${index}`, managed: true })));
    const summary = await summaryOf(app, adminToken);

    expect(summary).toHaveLength(12);
    expect(summary.every((entry) => entry.branch === 'main')).toBe(true);
    expect(fake.peak(), 'no more than four guest executions are live at once').toBeLessThanOrEqual(4);
  });

  // The register is polled. A branch changes rarely and each answer is a container command, so a second
  // read inside the window costs the guest nothing.
  it('reuses one answer across repeated register reads', async () => {
    const fake = provider({});
    const { app, adminToken } = setup(fake.control);

    expect((await summaryOf(app, adminToken))[0]!.branch).toBe('feat/managed');
    expect((await summaryOf(app, adminToken))[0]!.branch).toBe('feat/managed');
    expect(fake.executions, 'the second read is served from the memo').toHaveLength(1);
    expect(fake.environmentReads).toHaveLength(1);
  });
});
