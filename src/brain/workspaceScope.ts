import type {
  SandboxControl,
  SandboxWorkspaceBinding,
  SandboxWorkspaceRef,
} from '../plugins/api.js';

/** The ceiling one workspace resolution is measured against. `accountUserId` is the host's ONE account
 *  resolver (`pathGuard.currentAccess().accountUserId`): the contribution owner when the turn has one,
 *  else the verified identity. Reading only the contribution owner here is what made a turn able to
 *  CREATE a workspace through Sandbox and then be refused that same workspace by delegation. */
export interface WorkspaceAccessCeiling {
  admin: boolean;
  projectIds: readonly number[];
  accountUserId?: number | null;
  workspaceRef?: SandboxWorkspaceRef;
}

const sameRef = (a: SandboxWorkspaceRef, b: SandboxWorkspaceRef): boolean =>
  a.workspaceId === b.workspaceId && a.projectId === b.projectId;

export function resolveDelegatedWorkspace(
  sandbox: SandboxControl | undefined,
  access: WorkspaceAccessCeiling,
  requestedWorkspaceId?: string,
): SandboxWorkspaceBinding | undefined {
  const inherited = access.workspaceRef;
  const requested = typeof requestedWorkspaceId === 'string' ? requestedWorkspaceId.trim() : '';
  if (!requested && !inherited) return undefined;
  if (!sandbox) throw new Error('Sandbox workspace scope is unavailable because the Sandbox plugin is disabled');
  const accountUserId = access.accountUserId;
  if (!Number.isSafeInteger(accountUserId) || accountUserId! <= 0) {
    throw new Error('Sandbox workspace scope requires a linked Elowen account');
  }
  const workspace = inherited
    ? { ...inherited, ...(requested && requested !== inherited.workspaceId ? { workspaceId: requested } : {}) }
    : (() => {
        if (!requested) throw new Error('workspaceId is required');
        // The project id is not trusted from the caller. Resolve candidates only inside its current ceiling;
        // exactly one Sandbox row may own the id, and the control verifies the tuple below.
        const candidates = sandbox.workspacesFor({
          userId: accountUserId!,
          ...(access.admin ? {} : { projectIds: access.projectIds }),
        });
        const hit = candidates.find((candidate) => candidate.workspaceId === requested);
        if (!hit) throw new Error('workspace not found in the current project scope');
        return { workspaceId: hit.workspaceId, projectId: hit.projectId };
      })();
  if (inherited && !sameRef(inherited, workspace)) {
    throw new Error('a workspace-scoped child cannot switch to a sibling workspace');
  }
  return sandbox.resolveWorkspace({
    accountUserId: accountUserId!,
    workspace,
    accessibleProjectIds: access.admin ? 'all' : access.projectIds,
  });
}

export function bindingRef(binding: SandboxWorkspaceBinding): SandboxWorkspaceRef {
  return { workspaceId: binding.workspaceId, projectId: binding.projectId };
}
