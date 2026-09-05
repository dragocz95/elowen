import { describe, it, expect, vi } from 'vitest';
import { DelegatedSessionService } from '../../src/brain/service/delegatedSession.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { buildReadOnlyBoundary } from '../../src/brain/agents/readOnlyBoundary.js';
import type { DelegatedExecutionScope, DelegatingTurnAccess } from '../../src/brain/delegatedScope.js';
import type { NoninteractivePermissionBoundary } from '../../src/brain/toolPermissions.js';

const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-abc';
const SPAWNER = 'elowen:1';
const PARENT_BOUNDARY: NoninteractivePermissionBoundary = {
  rules: [{ scope: 'tools', pattern: '*', action: 'allow' }],
  unattendedAsks: 'allow',
};

const ACCESS: DelegatingTurnAccess = {
  admin: false, projectIds: [1], owner: false,
  toolPolicy: { allow: ['Bash', 'Delegate', 'Read', 'Write'] },
  permissionBoundary: PARENT_BOUNDARY,
  principal: SPAWNER,
};

const READ_ONLY_CHILD: DelegatedExecutionScope = {
  admin: false, projectIds: [1], owner: false,
  toolPolicy: { allow: ['Bash', 'Read'] },
  permissionBoundary: buildReadOnlyBoundary(PARENT_BOUNDARY),
  readOnlyOrigin: 'requested',
  spawnedBy: SPAWNER,
};

function setup(scope: DelegatedExecutionScope = READ_ONLY_CHILD) {
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: PARENT, userId: 1, model: 'k3' });
  store.createSession({ id: CHILD, userId: 1, model: 'k3', parentSessionId: PARENT, delegatedAccess: scope });
  const sessions = new LiveSessionRegistry();
  const send = vi.fn(async () => 'done, and written');
  const steerLocal = vi.fn(async () => 'idle' as const);
  const svc = new DelegatedSessionService({
    store, sessions,
    channelService: { send, steerDelegatedTurn: steerLocal, sendRemote: (_req: unknown, run: () => Promise<string>) => run() } as never,
    identity: { forDelegatedTurn: () => ({ platform: 'subagent', userId: 'subagent', admin: false, owner: false }) } as never,
    users: { get: () => ({}) } as never,
  });
  return { store, sessions, svc, send, steerLocal };
}

/** The write-mode promotion, end to end through the service that owns it. Two properties matter and both
 *  are asserted from real state rather than from the call's return value: a refusal must leave the child's
 *  durable scope untouched AND deliver nothing, and a successful promotion must actually reach the turn
 *  that follows it. */
describe('DelegatedSessionService.continueSubagent — promotion out of read-only', () => {
  it('rewrites the child\'s durable scope to the caller\'s current access and runs the follow-up', async () => {
    const { store, svc, send } = setup();
    const res = await svc.continueSubagent(PARENT, CHILD, 'now make the change', ACCESS, undefined, undefined, true);
    expect(res).toEqual({ status: 'reply', reply: 'done, and written' });
    const stored = store.delegatedAccessFor(CHILD);
    expect(stored?.toolPolicy).toEqual({ allow: ['Bash', 'Delegate', 'Read', 'Write'] });
    expect(stored?.permissionBoundary).toEqual(PARENT_BOUNDARY);
    expect(stored?.readOnlyOrigin).toBeUndefined();
    // The turn must run under the NEW scope, and the live session must be rebuilt — a session assembled
    // with the read-only toolset would otherwise keep it until it happened to be evicted.
    expect(send).toHaveBeenCalledTimes(1);
    const opts = send.mock.calls[0]![0] as { delegatedAccess: DelegatedExecutionScope; rebuildSession?: boolean; toolPolicy?: { allow?: Set<string> } };
    expect(opts.rebuildSession).toBe(true);
    expect(opts.delegatedAccess).toEqual(stored);
    expect([...(opts.toolPolicy?.allow ?? [])]).toContain('Write');
  });

  it('leaves the scope read-only when the follow-up does not ask for write access', async () => {
    const { store, svc, send } = setup();
    await svc.continueSubagent(PARENT, CHILD, 'summarize again', ACCESS);
    expect(store.delegatedAccessFor(CHILD)?.toolPolicy).toEqual({ allow: ['Bash', 'Read'] });
    expect(store.delegatedAccessFor(CHILD)?.readOnlyOrigin).toBe('requested');
    const opts = send.mock.calls[0]![0] as { rebuildSession?: boolean };
    expect(opts.rebuildSession).toBeUndefined();
  });

  describe('refuses without writing anything or delivering anything', () => {
    const refused = async (
      scope: DelegatedExecutionScope,
      access: DelegatingTurnAccess,
      pattern: RegExp,
      running = false,
    ): Promise<void> => {
      const { store, sessions, svc, send, steerLocal } = setup(scope);
      if (running) sessions.setChildRunning(PARENT, CHILD, true);
      await expect(svc.continueSubagent(PARENT, CHILD, 'now write it', access, undefined, undefined, true))
        .rejects.toThrow(pattern);
      expect(store.delegatedAccessFor(CHILD)?.toolPolicy).toEqual(scope.toolPolicy);
      expect(store.delegatedAccessFor(CHILD)?.readOnlyOrigin).toBe(scope.readOnlyOrigin);
      expect(send).not.toHaveBeenCalled();
      expect(steerLocal).not.toHaveBeenCalled();
    };

    // A running turn already assembled its tools; widening the scope under it would either do nothing or
    // read as having taken effect. The message must not be steered in either.
    it('a child that is mid-turn', async () => {
      await refused(READ_ONLY_CHILD, ACCESS, /turn in flight/, true);
    });

    it('a child whose read-only mode was imposed, not chosen', async () => {
      await refused({ ...READ_ONLY_CHILD, readOnlyOrigin: 'imposed' }, ACCESS, /not yours to choose/);
    });

    it('a promoter who is not the identity that spawned the child', async () => {
      await refused(READ_ONLY_CHILD, { ...ACCESS, principal: 'discord:42' }, /only the person whose request started/);
    });

    it('a planning turn, which cannot continue a sub-agent at all', async () => {
      await refused(READ_ONLY_CHILD, { ...ACCESS, readOnly: true, planMode: true }, /read-only|plan/i);
    });

    it('a caller whose own permission boundary has since been narrowed', async () => {
      await refused(READ_ONLY_CHILD, {
        ...ACCESS,
        permissionBoundary: { rules: [{ scope: 'tools', pattern: 'Write', action: 'deny' }], unattendedAsks: 'allow' },
      }, /permission/i);
    });
  });
});
