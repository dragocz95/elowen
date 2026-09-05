import { describe, it, expect } from 'vitest';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { currentAccess } from '../../src/plugins/pathGuard.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import { contributionOwnerForSession } from '../../src/brain/sessionId.js';
import { bindingRef, resolveDelegatedWorkspace } from '../../src/brain/workspaceScope.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SandboxControl } from '../../src/plugins/api.js';

/** Which ACCOUNT a turn acts as, and whether an explicit Sandbox workspace is admitted for it.
 *
 *  Composed from the REAL identity resolver, the REAL contribution-owner rule and the REAL turn scope
 *  rather than from a stubbed `currentAccess()`. A test that mocks the boundary can only ever confirm the
 *  arithmetic it was handed: the account is decided by how these three fit together, so that is what has
 *  to be exercised. */
const OWNER = 1;

const ADMIN_POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

const identities = new IdentityResolver({
  platformOwner: () => OWNER,
  users: { get: (id) => (id === OWNER ? { username: 'owner', name: 'Owner', is_admin: true } : null) },
  resolvePlatformUser: () => null, // an unlinked room sender, which is the account-less case below
});

/** One durable Sandbox workspace, owned by account 1 in project 1. The rows are a double; every rule that
 *  admits or refuses one is the host's own resolver. */
const sandbox = {
  workspacesFor: ({ userId }: { userId: number }) => (userId === OWNER
    ? [{ workspaceId: 'ws_owned', projectId: 1, path: '/host/ws_owned', label: 'ws', branch: 'b', baseRef: 'main' }]
    : []),
  resolveWorkspace: ({ accountUserId, workspace }: { accountUserId: number; workspace: { workspaceId: string; projectId: number } }) =>
    ({ accountUserId, ...workspace, path: `/host/${workspace.workspaceId}` }),
} as unknown as SandboxControl;

/** The account the delegated scope of a child spawned from that owner turn carries. */
const childScope = (contributionUserId: number | undefined): DelegatedExecutionScope => ({
  admin: true,
  projectIds: [],
  owner: true,
  permissionBoundary: null,
  ...(contributionUserId !== undefined ? { contributionUserId } : {}),
} as DelegatedExecutionScope);

describe('the account a turn acts as', () => {
  it('resolves an owner chat turn to its own account', () => {
    // Exactly what turnContextBuilder.scopeOptions puts on the turn scope for an owner chat: the identity
    // the resolver mints, and the contribution owner the session rule decides — for an owner session that
    // is the session owner, so both name account 1 and they must agree.
    const sessionId = `brain-${OWNER}-abcdef`;
    const access = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity: identities.forOwnerChat(OWNER, ADMIN_POLICY),
      sessionId,
      contributionUserId: contributionOwnerForSession(sessionId, OWNER, {}),
    });

    expect(access.accountUserId).toBe(OWNER);
    expect(access.contributionUserId).toBe(OWNER);
  });

  it('resolves an owner chat turn composed without a contribution scope through its verified identity', () => {
    // The identity fallback, and the reason it exists: `SandboxCreateWorkspace` and every other
    // account-owned tool answer for this turn, so a delegation refusing it would contradict the tool that
    // created the thing being delegated into.
    const access = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity: identities.forOwnerChat(OWNER, ADMIN_POLICY),
      sessionId: `brain-${OWNER}-abcdef`,
      contributionUserId: null,
    });

    expect(access.accountUserId).toBe(OWNER);
    expect(access.contributionUserId).toBeNull();
  });

  it('carries the spawning turn\'s account into a delegated child, whose identity has none', () => {
    // A delegated identity deliberately names no account (see IdentityResolver.forDelegatedTurn), so the
    // child's account can only come from the contribution owner it inherited. Reading the identity here is
    // what would leave a workspace-scoped child unable to name its own worktree.
    const scope = childScope(OWNER);
    const identity = identities.forDelegatedTurn(scope, OWNER);
    expect(identity.elowenUserId).toBeUndefined();

    const access = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity,
      sessionId: 'brain-ch-subagent-sub-dlg-1',
      contributionUserId: scope.contributionUserId ?? null,
    });

    expect(access.accountUserId).toBe(OWNER);
  });

  it('leaves an unlinked room sender without an account', () => {
    // A shared room resolves its contributions to the VERIFIED WRITER and to nobody when the writer is
    // unlinked; the identity carries no account either. Neither source may be widened to the room's owner.
    const sessionId = 'brain-ch-discord-1234';
    const { identity } = identities.forPlatformTurn(
      { platform: 'discord', userId: 'stranger', roleIds: [], channelId: '1234', access: {} },
      OWNER,
    );
    expect(identity.elowenUserId).toBeUndefined();

    const access = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity,
      sessionId,
      contributionUserId: contributionOwnerForSession(sessionId, OWNER, { direct: false }),
    });

    expect(access.accountUserId).toBeNull();
  });
});

describe('resolving an explicit Sandbox workspace against that account', () => {
  const ownerChatAccess = () => runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
    identity: identities.forOwnerChat(OWNER, ADMIN_POLICY),
    sessionId: `brain-${OWNER}-abcdef`,
    contributionUserId: null, // the identity-only shape, the narrower of the two owner-chat cases
  });

  it('admits the owner turn\'s own workspace', () => {
    const binding = resolveDelegatedWorkspace(sandbox, ownerChatAccess(), 'ws_owned');
    expect(binding && bindingRef(binding)).toEqual({ workspaceId: 'ws_owned', projectId: 1 });
  });

  it('admits it again for a child that inherited that account', () => {
    const scope = childScope(OWNER);
    const access = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity: identities.forDelegatedTurn(scope, OWNER),
      sessionId: 'brain-ch-subagent-sub-dlg-1',
      contributionUserId: scope.contributionUserId ?? null,
    });

    const binding = resolveDelegatedWorkspace(sandbox, access, 'ws_owned');
    expect(binding && bindingRef(binding)).toEqual({ workspaceId: 'ws_owned', projectId: 1 });
  });

  it('refuses a turn that names no account rather than resolving it against somebody', () => {
    const access = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity: identities.forPlatformTurn(
        { platform: 'discord', userId: 'stranger', roleIds: [], channelId: '1234', access: {} },
        OWNER,
      ).identity,
      sessionId: 'brain-ch-discord-1234',
      contributionUserId: null,
    });

    expect(access.accountUserId).toBeNull();
    expect(() => resolveDelegatedWorkspace(sandbox, access, 'ws_owned'))
      .toThrow(/requires a linked Elowen account/);
  });

  it('refuses another account\'s workspace even for an admin turn', () => {
    const foreign = runWithPolicy(ADMIN_POLICY, () => currentAccess(), {
      identity: identities.forOwnerChat(2, ADMIN_POLICY),
      sessionId: 'brain-2-abcdef',
      contributionUserId: 2,
    });

    expect(foreign.accountUserId).toBe(2);
    expect(() => resolveDelegatedWorkspace(sandbox, foreign, 'ws_owned'))
      .toThrow(/workspace not found in the current project scope/);
  });
});
