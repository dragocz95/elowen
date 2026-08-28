import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { initSandboxDb, reconcileStaleLeases } from './lib/db.mjs';
import {
  bubblewrapProbe, createExecutionService, migrateLegacyHomes, removeUserData,
} from './lib/execution.mjs';
import { createWorkspaceService } from './lib/workspaces.mjs';
import { registerSandboxApi } from './lib/api.mjs';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (error) => ok(`Error: ${error instanceof Error ? error.message : String(error)}`, {
  ok: false,
  error: { code: error?.code || 'sandbox_error', message: error instanceof Error ? error.message : String(error) },
});

function workspaceText(workspace, state, active = false) {
  const status = state?.status;
  const flags = [
    active ? 'ACTIVE' : null,
    workspace.lifecycle === 'orphaned' ? `ORPHANED:${workspace.orphanReason || 'unknown'}` : null,
    status ? `${status.dirty} changed` : null,
    status ? `${status.untracked} untracked` : null,
    status ? `${status.ahead} ahead/${status.behind} behind` : null,
  ].filter(Boolean).join(', ');
  return `- ${workspace.id} ${workspace.label} [${workspace.branch} from ${workspace.baseRef}]${flags ? ` — ${flags}` : ''}\n  ${workspace.path}`;
}

export async function register(ctx) {
  const db = initSandboxDb(ctx);
  const dataDir = ctx.dataDir();
  // Forked sub-agent runners consume the daemon-migrated database and must not race a filesystem handoff.
  // They still create account HOME lazily through prepareExecution when a delegated command actually runs.
  const migrationState = typeof process.send === 'function'
    ? { collisions: [], migrated: 0, retainedSessions: [] }
    : migrateLegacyHomes(dataDir);
  let workspaces;
  const execution = createExecutionService({ ctx, db, dataDir, listWorkspaces: () => workspaces?.listWorkspaces() ?? [] });
  workspaces = createWorkspaceService({ ctx, db, dataDir, execution });

  const accountId = () => ctx.currentContributionUserId() ?? ctx.currentIdentity()?.elowenUserId ?? null;
  const sessionId = () => ctx.currentSessionId() ?? null;
  const accessibleProjects = () => {
    const access = ctx.currentAccess();
    return access.admin ? ctx.host.stores().projects.list().map((project) => project.id) : access.projectIds;
  };
  const activeFor = (projectId) => {
    const userId = accountId();
    const session = sessionId();
    if (userId === null || !session) return null;
    return workspaces.activeWorkspace({ accountUserId: userId, sessionId: session, projectId });
  };

  ctx.registerControl('sandbox', {
    workspaceRoots: ({ projectIds }) => {
      const accountUserId = accountId();
      return accountUserId === null ? [] : workspaces.workspaceRoots({ accountUserId, projectIds });
    },
    // Explicit account, for consumers with no ambient scope to read (background services have neither an
    // identity nor a session). Deliberately does NOT re-check project access: the caller names the account
    // and must apply its own tenancy rule, exactly as it must for the project paths it already resolves.
    workspacesFor: ({ userId, projectIds }) => (
      Number.isSafeInteger(userId) ? workspaces.workspacesFor({ userId, projectIds }) : []
    ),
    activeWorkspace: (input) => {
      const accountUserId = accountId();
      if (accountUserId === null) return null;
      const workspace = workspaces.activeWorkspace({ ...input, accountUserId });
      return workspace ? {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        path: workspace.path,
        label: workspace.label,
        branch: workspace.branch,
        baseRef: workspace.baseRef,
      } : null;
    },
    // A background service has no ambient turn to read: no identity, no session, no allowed roots. It
    // must therefore name the account and the directories itself, exactly as `workspacesFor` lets it
    // name the account — and, exactly as there, the caller owns the tenancy rule for what it named.
    //
    // What it may NOT name is `owner`. That flag is what selects DIRECT execution: no bubblewrap and
    // the daemon's whole environment handed to the child. It is a property of who is driving the turn,
    // never of what a plugin asks for, so an explicit request is always confined. `skipHomeLock` stays
    // internal too: the lease has to be minted under the HOME lock or a reset can race a launch.
    prepareExecution: (input, options) => execution.prepare(
      input,
      options === undefined ? undefined : {
        accountUserId: options.accountUserId,
        roots: options.roots,
        owner: false,
        forceConfined: true,
      },
    ),
  });

  ctx.registerTool(defineTool({
    name: 'SandboxListWorkspaces',
    label: 'List workspaces',
    description: 'List this account’s local Git workspaces, with their branch, base ref, active binding and live dirty/untracked/ahead/behind status. The list is limited to Projects the account can access now; revoked Projects are not a path escape hatch.',
    parameters: Type.Object({ projectId: Type.Optional(Type.Integer({ minimum: 1, description: 'Limit the list to one accessible Project id.' })) }),
    execute: async (_id, input) => {
      try {
        const userId = accountId();
        if (userId === null) throw new Error('a linked Elowen account is required');
        const allowed = new Set(accessibleProjects());
        const rows = workspaces.listWorkspaces({ userId, ...(input.projectId ? { projectId: input.projectId } : {}) })
          .filter((workspace) => allowed.has(workspace.projectId));
        if (rows.length === 0) return ok('No sandbox workspaces.');
        const rendered = [];
        for (const workspace of rows) {
          const state = await workspaces.statusFor(workspace, { accountUserId: userId });
          rendered.push(workspaceText(workspace, state, activeFor(workspace.projectId)?.id === workspace.id));
        }
        return ok(rendered.join('\n'));
      } catch (error) { return fail(error); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'SandboxCreateWorkspace',
    label: 'Create workspace',
    description: 'Create a real Git worktree for one accessible Project. The label is display text only; Sandbox generates a safe unique branch under elowen/u<account>/ and binds the new workspace to this conversation.',
    parameters: Type.Object({
      projectId: Type.Integer({ minimum: 1, description: 'Accessible Project id whose Git repository owns the worktree.' }),
      label: Type.String({ minLength: 1, maxLength: 80, description: 'Human-readable workspace label, not a Git ref.' }),
      baseRef: Type.String({ minLength: 1, maxLength: 200, description: 'Existing branch, tag or commit to start from, for example main.' }),
    }),
    execute: async (_id, input) => {
      try {
        const session = sessionId();
        if (!session) throw new Error('workspace creation requires a conversation');
        const workspace = await workspaces.createWorkspace({ ...input, sessionId: session }, { accessibleProjects: accessibleProjects() });
        return ok(`Created and activated ${workspace.label} (${workspace.id})\nBranch: ${workspace.branch}\nPath: ${workspace.path}`, { workspace });
      } catch (error) { return fail(error); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'SandboxUseWorkspace',
    label: 'Use workspace',
    description: 'Make one of this account’s workspaces active for this conversation and Project. Subsequent relative Files and Bash operations resolve to that worktree; explicit paths remain guarded by current Project access.',
    parameters: Type.Object({ workspaceId: Type.String({ minLength: 1, description: 'Workspace id from SandboxListWorkspaces.' }) }),
    execute: async (_id, input) => {
      try {
        const workspace = workspaces.workspaceById(input.workspaceId);
        const session = sessionId();
        if (!workspace) throw new Error('workspace not found');
        if (!session) throw new Error('workspace activation requires a conversation');
        workspaces.useWorkspace({ workspaceId: workspace.id, sessionId: session, projectId: workspace.projectId }, { accessibleProjects: accessibleProjects() });
        return ok(`Using ${workspace.label} (${workspace.branch}) for Project ${workspace.projectId}.`, { workspace });
      } catch (error) { return fail(error); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'SandboxCommit',
    label: 'Commit workspace changes',
    description: 'Commit selected paths in the active workspace. Paths are explicit and workspace-relative; Sandbox never runs git add -A. Repository hooks are disabled. Unselected changes remain in the workspace and are reported after the commit.',
    parameters: Type.Object({
      projectId: Type.Integer({ minimum: 1, description: 'Project whose active workspace should be committed.' }),
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'Explicit workspace-relative paths to stage and commit.' }),
      message: Type.String({ minLength: 1, maxLength: 500, description: 'Git commit message.' }),
    }),
    execute: async (_id, input) => {
      try {
        const workspace = activeFor(input.projectId);
        if (!workspace) throw new Error('no active workspace is bound to this conversation and Project');
        const result = await workspaces.commitWorkspace({ workspaceId: workspace.id, paths: input.paths, message: input.message }, { accessibleProjects: accessibleProjects() });
        const remaining = result.remaining.status;
        return ok(`Committed ${result.head}. Remaining: ${remaining?.dirty ?? 0} changed, ${remaining?.untracked ?? 0} untracked.`, { head: result.head, remaining: result.remaining });
      } catch (error) { return fail(error); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'SandboxRemoveWorkspace',
    label: 'Remove clean workspace',
    description: 'Remove one workspace only when its tree is clean, it has no untracked files, no commits beyond its base ref, and no active process lease. This model tool never force-deletes work or bypasses those checks.',
    parameters: Type.Object({ workspaceId: Type.String({ minLength: 1, description: 'Workspace id from SandboxListWorkspaces.' }) }),
    execute: async (_id, input) => {
      try {
        const result = await workspaces.removeWorkspace(input, { accessibleProjects: accessibleProjects(), allowDiscard: false });
        return ok(`Removed workspace ${result.removed}.`, result);
      } catch (error) { return fail(error); }
    },
  }));

  registerSandboxApi({ ctx, db, dataDir, workspaces, execution, migrationState });

  ctx.registerReadinessCheck(() => {
    if (migrationState.collisions.length > 0) return {
      id: 'sandbox', label: 'Sandbox', ok: false,
      detail: 'Legacy and current account HOME directories both exist; migration was refused.',
      hint: 'Inspect plugins-data/terminal/sandbox-home and plugins-data/sandbox/users before choosing which HOME to retain.',
    };
    if (migrationState.retainedSessions.length > 0) return {
      id: 'sandbox', label: 'Sandbox', ok: false,
      detail: `${migrationState.retainedSessions.length} legacy session HOME director${migrationState.retainedSessions.length === 1 ? 'y is' : 'ies are'} retained because process ownership cannot be verified.`,
      hint: 'Confirm no legacy process uses these directories, then remove them manually from plugins-data/terminal/sandbox-home.',
    };
    if (ctx.config.confineNonOperators === false) return {
      id: 'sandbox', label: 'Sandbox', ok: true,
      detail: 'Account HOME and workspaces are ready; non-operator confinement is disabled by configuration.',
    };
    const probe = bubblewrapProbe();
    return probe.available
      ? { id: 'sandbox', label: 'Sandbox', ok: true, detail: 'bubblewrap confinement probe passed; account HOME and workspaces are ready.' }
      : { id: 'sandbox', label: 'Sandbox', ok: false, detail: `Confined execution is unavailable: ${probe.reason || 'probe failed'}.`, hint: 'Install bubblewrap and permit its unprivileged namespace profile; non-operator shell commands fail closed until the probe passes.' };
  });

  ctx.registerBootReconcile(async () => {
    reconcileStaleLeases(db);
    const knownUsers = new Set(ctx.host.stores().usersRead.list().map((user) => user.id));
    const orphanUsers = [...new Set(workspaces.listWorkspaces().map((workspace) => workspace.userId))].filter((userId) => !knownUsers.has(userId));
    for (const userId of orphanUsers) {
      await workspaces.removeAccount(userId);
      removeUserData(dataDir, userId);
    }
    await workspaces.reconcile();
  });

  ctx.registerInterval('lease-reconcile', () => { reconcileStaleLeases(db); }, 10_000);

  ctx.registerUserRemoved(async (userId) => {
    await workspaces.removeAccount(userId);
    removeUserData(dataDir, userId);
  });
  ctx.registerProjectRemoved((projectId) => { workspaces.markProjectOrphaned(projectId); });

  ctx.registerHook({
    name: 'plugin.reload.before',
    run: () => {
      // The durable rows intentionally survive a reload. Only stale owners are reaped; live children keep
      // their leases until their real exit so workspace/HOME deletion remains blocked across generations.
      reconcileStaleLeases(db);
    },
  });

  ctx.logger.info(`registered Sandbox workspaces, account HOME and execution control${migrationState.migrated ? `; migrated ${migrationState.migrated} legacy HOME(s)` : ''}`);
}
