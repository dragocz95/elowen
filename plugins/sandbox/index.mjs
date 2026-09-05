import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createExecutionLease, initSandboxDb, reconcileStaleLeases } from './lib/db.mjs';
import {
  bubblewrapProbe, createExecutionService, ensureUserHome, migrateLegacyHomes, removeUserData,
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
    resolveWorkspace: (input) => workspaces.resolveWorkspace(input),
    acquireDelegationLease: (input) => {
      const binding = workspaces.resolveWorkspace({
        ...input,
        accessibleProjectIds: [input.workspace.projectId],
      });
      const generation = ensureUserHome(dataDir, binding.accountUserId).generation;
      return createExecutionLease(db, {
        accountUserId: binding.accountUserId,
        workspaceId: binding.workspaceId,
        homeGeneration: generation,
        kind: 'terminal',
      });
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
    // The project-free form of the lookup above, for the ONE caller that cannot name a project: the turn
    // resolver, whose only clue is a cwd. A switch may bind a project that cwd sits nowhere near, so the
    // answer is the conversation's most recent binding among the projects the caller says are accessible.
    // The account is still ambient and the project ceiling still comes from the caller, so this widens
    // nothing: it only stops a legitimate switch from being invisible.
    activeSessionWorkspace: ({ sessionId, projectIds }) => {
      const accountUserId = accountId();
      if (accountUserId === null) return null;
      const workspace = workspaces.activeSessionWorkspace({ accountUserId, sessionId, projectIds });
      return workspace ? {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        path: workspace.path,
        label: workspace.label,
        branch: workspace.branch,
        baseRef: workspace.baseRef,
      } : null;
    },
    // The inverse of a switch, for the one caller that has to undo one: the daemon, when a conversation is
    // explicitly MOVED to a Project. `projectIds` is the caller's own accessibility ceiling and the account
    // stays ambient, exactly as in `activeSessionWorkspace` — a daemon-side caller has a Policy but no
    // plugin turn scope, so the ambient access read would answer "no projects" and release nothing.
    releaseSessionWorkspaces: ({ sessionId, projectIds, keepProjectId }) => {
      const accountUserId = accountId();
      if (accountUserId === null) throw new Error('a linked Elowen account is required');
      return workspaces.releaseSessionWorkspaces(
        { sessionId, ...(keepProjectId === undefined ? {} : { keepProjectId }) },
        {
          userId: accountUserId,
          accessibleProjects: [...(projectIds ?? [])],
          verifySessionOwner: workspaces.verifySessionOwner,
        },
      );
    },
    // Two callers, neither with an ambient turn to read, and they are NOT the same caller.
    //
    // An explicit `workspace` is a DELEGATED turn pinned to one worktree: the account comes from the
    // current turn and the workspace is re-resolved against it, so a stale, foreign or path-mismatched
    // id is refused rather than silently widened to a Project.
    //
    // `options` is a BACKGROUND SERVICE: no identity, no session, no allowed roots, so it must name the
    // account and the directories itself, exactly as `workspacesFor` lets it name the account — and,
    // exactly as there, the caller owns the tenancy rule for what it named. What it may NOT name is
    // `owner`. That flag selects DIRECT execution: no bubblewrap, and the daemon's whole environment
    // handed to the child. It is a property of who is driving the turn, never of what a plugin asks
    // for, so an explicit request is always confined. `skipHomeLock` stays internal too: the lease has
    // to be minted under the HOME lock or a reset can race a launch.
    prepareExecution: (input, options) => {
      if (input.workspace) {
        const accountUserId = accountId();
        if (accountUserId === null) throw new Error('a linked Elowen account is required');
        const binding = workspaces.resolveWorkspace({
          accountUserId,
          workspace: input.workspace,
          accessibleProjectIds: accessibleProjects(),
        });
        const workspace = workspaces.workspaceById(binding.workspaceId);
        if (!workspace) throw new Error('workspace not found');
        return execution.prepare(input, { workspace, accountUserId });
      }
      return execution.prepare(
        input,
        options === undefined ? undefined : {
          accountUserId: options.accountUserId,
          roots: options.roots,
          owner: false,
          forceConfined: true,
        },
      );
    },
    gitStatus: async (input) => {
      const binding = workspaces.resolveWorkspace({
        accountUserId: input.accountUserId,
        workspace: input.workspace,
        accessibleProjectIds: [input.workspace.projectId],
      });
      const workspace = workspaces.workspaceById(binding.workspaceId);
      if (!workspace) throw new Error('workspace not found');
      const state = await workspaces.statusFor(workspace, { accountUserId: input.accountUserId });
      if (!state.isRepo || !state.status) throw new Error('workspace is not a Git repository');
      return {
        branch: state.status.head || workspace.branch,
        lines: state.files.map((file) => `${file.code} ${file.path}`),
      };
    },
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
    description: 'Create a real Git worktree for one accessible Project, named either by projectId or by projectPath (the absolute path of an existing accessible Project root, matched canonically; a descendant or unknown path is refused without revealing other Projects). The label names the worktree directory and the branch under elowen/u<account>/ (slugified, suffixed only when that name is taken), so choose it as you would a branch name; the workspace is bound to this conversation.',
    parameters: Type.Object({
      projectId: Type.Optional(Type.Integer({ minimum: 1, description: 'Accessible Project id whose Git repository owns the worktree. Provide this or projectPath.' })),
      projectPath: Type.Optional(Type.String({ minLength: 1, description: 'Absolute path of an existing accessible Project root, canonicalized before matching. Provide this or projectId.' })),
      label: Type.String({ minLength: 1, maxLength: 80, description: 'Workspace name; also becomes the directory and branch name after slugification.' }),
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
    name: 'SandboxReleaseWorkspace',
    label: 'Release workspace',
    description: 'Give this conversation its Project directory back: unbind the active Sandbox workspace(s) so the next turn runs in the Project again instead of inside the workspace container. Nothing is destroyed — the workspace, its branch and its directory are preserved and can be re-activated with SandboxUseWorkspace. Refused while a process still runs in the workspace. Takes effect on the next turn.',
    parameters: Type.Object({
      projectId: Type.Optional(Type.Integer({ minimum: 1, description: 'Release only this Project’s binding. Omit to release every binding of this conversation.' })),
    }),
    execute: async (_id, input) => {
      try {
        const userId = accountId();
        if (userId === null) throw new Error('a linked Elowen account is required');
        const session = sessionId();
        if (!session) throw new Error('workspace release requires a conversation');
        const result = workspaces.releaseSessionWorkspaces(
          { sessionId: session, ...(input.projectId ? { projectId: input.projectId } : {}) },
          { userId, accessibleProjects: accessibleProjects(), verifySessionOwner: workspaces.verifySessionOwner },
        );
        if (result.released === 0) return ok('No workspace is bound to this conversation; nothing to release.', result);
        return ok(`Released ${result.released} workspace binding${result.released === 1 ? '' : 's'} (${result.workspaceIds.join(', ')}). The next turn runs in the Project directory. Each workspace, its branch and its directory are preserved.`, result);
      } catch (error) {
        if (error?.code === 'workspace_in_use') {
          return fail(Object.assign(new Error('a process is still running in the bound workspace; wait for it to finish or kill it, then release again'), { code: 'workspace_in_use' }));
        }
        return fail(error);
      }
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

  // The plugin declares the command; each surface owns the chooser it draws for it. A picker carries no
  // prompt — there is no model turn behind it — and because the declaration lives here, switching the
  // plugin off removes `/sandbox` from every published menu with nothing for core to withhold.
  ctx.registerCommand({
    name: 'sandbox',
    description: 'Inspect and manage Sandbox workspaces',
    kind: 'picker',
    surfaces: ['cli', 'web'],
  });

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
