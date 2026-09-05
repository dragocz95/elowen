import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { Policy } from '../../src/plugins/policy.js';

const dirs: string[] = [];
/** A throwaway worktree whose HEAD names `branch` — the project section reads the branch off disk. The
 *  real path is returned because the reported cwd is realpath-resolved before it is authorized. */
function repo(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), 'status-project-'));
  dirs.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return realpathSync(root);
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type StatusDeps = ConstructorParameters<typeof BrainStatusService>[0];

function harness(policy?: (userId: number) => Policy, extra: Pick<StatusDeps, 'projects' | 'sandbox' | 'projectPath'> = {}) {
  const store = new BrainStore(openDb(':memory:'));
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const elicitation = new ElicitationRegistry();
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    // status() never reaches spawning, goal continuation or model permissions.
    goals: { cancelGoalContinuation: () => {} } as unknown as ConstructorParameters<typeof ConversationLifecycle>[0]['goals'],
    spawn: () => Promise.reject(new Error('no spawn in this harness')),
    selectionAllowed: () => true,
  });
  const status = new BrainStatusService({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    cards: new CardRegistry(),
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config: undefined,
    runtime: undefined as unknown as StatusDeps['runtime'],
    policy,
    ...extra,
  });
  return { store, sessions, status };
}

/** A Sandbox control that answers exactly one binding for one conversation, the way the plugin's
 *  `activeSessionWorkspace` does — with the same fields, so the status seam sees what a turn sees. */
function sandboxWith(binding: { sessionId: string; workspaceId: string; projectId: number; path: string; label: string; branch: string }) {
  const workspace = { workspaceId: binding.workspaceId, projectId: binding.projectId, path: binding.path, label: binding.label, branch: binding.branch, baseRef: 'main' };
  return {
    workspaceRoots: () => [{ workspaceId: workspace.workspaceId, projectId: workspace.projectId, path: workspace.path }],
    activeSessionWorkspace: ({ sessionId }: { sessionId: string }) => (sessionId === binding.sessionId ? workspace : null),
    activeWorkspace: () => workspace,
  } as unknown as NonNullable<ReturnType<NonNullable<StatusDeps['sandbox']>>>;
}

describe('status() project section', () => {
  it('projects activity from the session listing row without per-session reads', () => {
    const { store, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'user', content: { role: 'user', content: 'hello' } });
    store.setDelegationBootId('boot-1');
    store.beginSessionActivity('brain-1', 'turn-1', 'web');
    const activityRead = vi.spyOn(store, 'getSessionActivity');

    expect(status.listSessions(1)[0]?.activity).toMatchObject({ state: 'working', seq: 1, unread: true });
    expect(activityRead).not.toHaveBeenCalled();
  });

  it('reports the conversation\'s stored work dir and its git branch', () => {
    const { store, status } = harness();
    const root = repo('telemetry');
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    store.setWorkDir('brain-1', root);
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: root, branch: 'telemetry', workspace: null });
  });

  it('a conversation with no recorded directory reports nulls, not the daemon process cwd', () => {
    const { store, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: null, branch: null, workspace: null });
  });

  // The live session's directory wins over the stored stamp: a `/cd` moves the live conversation before
  // the row catches up, and the panel must describe where the agent actually works.
  it('prefers the live session work dir over the stored stamp', () => {
    const { store, sessions, status } = harness();
    const stored = repo('stored');
    const live = repo('live');
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    store.setWorkDir('brain-1', stored);
    sessions.set('brain-1', {
      sessionId: 'brain-1', workDir: live, requestProfile: { fast: false },
      session: {
        getContextUsage: () => undefined, messages: [],
        getSteeringMessages: () => [], getFollowUpMessages: () => [],
      },
    } as unknown as LiveBrain);
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: live, branch: 'live', workspace: null });
  });

  // The scoping guarantee: another user's conversation must never surface its path, not even to an
  // otherwise-valid caller who guesses the session id. The route turns this throw into a 404.
  it('refuses a foreign conversation instead of leaking its directory', () => {
    const { store, status } = harness();
    const root = repo('secret');
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' });
    store.setWorkDir('brain-2', root);
    expect(() => status.status(1, 'brain-2')).toThrow('unknown session');
    // …and user 1's own default view describes user 1, never the neighbour's directory.
    expect(status.status(1).project).toEqual({ cwd: null, branch: null, workspace: null });
  });

  // Project access is re-read on every poll and never inherited from the stamp: once the project is
  // unassigned the directory and the branch must both disappear, otherwise a user who lost access keeps
  // polling the live branch — and the path — of a repository they may no longer reach.
  it('stops reporting the directory and branch once project access is revoked', () => {
    const root = repo('secret-work');
    let roots = [root];
    const { store, status } = harness(() => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots }));
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    store.setWorkDir('brain-1', root);
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: root, branch: 'secret-work', workspace: null });
    roots = [];
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: null, branch: null, workspace: null });
  });

  /** The indicator has to say what a Bash command in THIS conversation will do, so it is computed by the
   *  same resolver a turn runs (effectiveTurnWorkDir), against the same Sandbox control — never re-derived
   *  from binding rows. A bound workspace means the shell runs in the container with the worktree at
   *  /workspace, and the reported cwd is the worktree, because that is where the turn works. */
  it('reports the bound Sandbox workspace as the confined place the conversation works', () => {
    const project = repo('main');
    const worktree = repo('elowen/u1/feature');
    const projects = { list: () => [{ id: 1, path: project }] };
    const sandbox = sandboxWith({ sessionId: 'brain-1', workspaceId: 'ws_1', projectId: 1, path: worktree, label: 'feature', branch: 'elowen/u1/feature' });
    const { store, status } = harness(
      () => ({ allowedProjectIds: new Set([1]), allowedPaths: () => [project, worktree] }),
      { projects: projects as unknown as StatusDeps['projects'], sandbox: () => sandbox },
    );
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    store.setWorkDir('brain-1', project);
    expect(status.status(1, 'brain-1').project).toEqual({
      cwd: worktree,
      branch: 'elowen/u1/feature',
      workspace: { workspaceId: 'ws_1', label: 'feature', branch: 'elowen/u1/feature', confined: true },
    });
  });

  it('reports no workspace for a conversation the Sandbox has no binding for', () => {
    const project = repo('main');
    const worktree = repo('elowen/u1/feature');
    const projects = { list: () => [{ id: 1, path: project }] };
    const sandbox = sandboxWith({ sessionId: 'brain-other', workspaceId: 'ws_1', projectId: 1, path: worktree, label: 'feature', branch: 'elowen/u1/feature' });
    const { store, status } = harness(
      () => ({ allowedProjectIds: new Set([1]), allowedPaths: () => [project, worktree] }),
      { projects: projects as unknown as StatusDeps['projects'], sandbox: () => ({ ...sandbox, activeWorkspace: () => null }) },
    );
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    store.setWorkDir('brain-1', project);
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: project, branch: 'main', workspace: null });
  });
});
