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

function harness(policy?: (userId: number) => Policy) {
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
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
    policy,
  });
  return { store, sessions, status };
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
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: root, branch: 'telemetry' });
  });

  it('a conversation with no recorded directory reports nulls, not the daemon process cwd', () => {
    const { store, status } = harness();
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: null, branch: null });
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
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: live, branch: 'live' });
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
    expect(status.status(1).project).toEqual({ cwd: null, branch: null });
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
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: root, branch: 'secret-work' });
    roots = [];
    expect(status.status(1, 'brain-1').project).toEqual({ cwd: null, branch: null });
  });
});
