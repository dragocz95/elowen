import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { activeExecutionLeases, withRepoLease } from './db.mjs';
import { bubblewrapProbe, directorySize, ensureUserHome, resetUserHome, runPrepared } from './execution.mjs';

const json = (body, status = 200) => ({ status, body });
const errorResponse = (error) => json({
  error: error?.code || 'sandbox_error',
  detail: error instanceof Error ? error.message : String(error),
}, Number(error?.status) || 500);

async function body(req) {
  const parsed = await req.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('JSON object body required'), { code: 'invalid_body', status: 400 });
  return parsed;
}

function accessibleProjects(req, stores) {
  if (req.auth.accessibleProjects === null) return req.auth.admin ? stores.projects.list().map((project) => project.id) : [];
  return req.auth.accessibleProjects;
}

function requireUser(req) {
  if (!Number.isSafeInteger(req.auth.userId) || req.auth.userId <= 0) throw Object.assign(new Error('a linked Elowen account is required'), { code: 'account_required', status: 401 });
  return req.auth.userId;
}

export function registerSandboxApi({ ctx, db, dataDir, workspaces, execution, migrationState }) {
  const stores = ctx.host.stores();
  const register = (path, method, handler) => ctx.registerApiRoute({
    path, method, access: 'user',
    handler: async (req) => {
      try { return await handler(req); }
      catch (error) { return errorResponse(error); }
    },
  });

  register('overview', 'GET', async (req) => {
    const userId = requireUser(req);
    const allowed = accessibleProjects(req, stores);
    const projects = stores.projects.list().filter((project) => allowed.includes(project.id));
    const sessions = workspaces.sessionListForUser(userId);
    const rows = workspaces.listWorkspaces({ userId }).filter((workspace) => allowed.includes(workspace.projectId));
    const items = await Promise.all(rows.map(async (workspace) => {
      const state = await workspaces.statusFor(workspace, { accountUserId: userId });
      const bindings = db.prepare(`SELECT session_id, updated_at FROM p_sandbox_session_bindings
        WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC`).all(userId, workspace.id)
        .map((row) => ({ sessionId: String(row.session_id), updatedAt: String(row.updated_at) }));
      return {
        ...workspace,
        accessible: allowed.includes(workspace.projectId),
        status: state.status,
        files: state.files,
        uniqueCommits: state.uniqueCommits,
        activeProcesses: activeExecutionLeases(db, { workspaceId: workspace.id }).length,
        bindings,
      };
    }));
    return json({ projects, sessions, workspaces: items });
  });

  register('workspaces/create', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const workspace = await workspaces.createWorkspace(input, { userId, accessibleProjects: accessibleProjects(req, stores) });
    return json({ workspace }, 201);
  });

  register('workspaces/use', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const workspace = workspaces.useWorkspace(input, {
      userId,
      accessibleProjects: accessibleProjects(req, stores),
      verifySessionOwner: workspaces.verifySessionOwner,
    });
    return json({ workspace });
  });

  register('workspaces/commit', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const result = await workspaces.commitWorkspace(input, { userId, accessibleProjects: accessibleProjects(req, stores) });
    return json({ head: result.head, remaining: result.remaining });
  });

  register('workspaces/diff', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const workspace = workspaces.workspaceById(String(input.workspaceId));
    if (!workspace || workspace.userId !== userId) throw Object.assign(new Error('workspace not found'), { code: 'workspace_not_found', status: 404 });
    if (!accessibleProjects(req, stores).includes(workspace.projectId)) throw Object.assign(new Error('project is not accessible'), { code: 'project_forbidden', status: 403 });
    const state = await workspaces.statusFor(workspace, { accountUserId: userId });
    return json({ diff: state.diff, files: state.files });
  });

  register('workspaces/remove-preview', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const workspace = workspaces.workspaceById(String(input.workspaceId));
    if (!workspace || workspace.userId !== userId) throw Object.assign(new Error('workspace not found'), { code: 'workspace_not_found', status: 404 });
    if (!accessibleProjects(req, stores).includes(workspace.projectId)) throw Object.assign(new Error('project is not accessible'), { code: 'project_forbidden', status: 403 });
    return json(await workspaces.removalPreview(workspace));
  });

  register('workspaces/remove', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const result = await workspaces.removeWorkspace(input, {
      userId,
      accessibleProjects: accessibleProjects(req, stores),
      allowDiscard: input.discard === true,
    });
    return json(result);
  });

  const gitConfig = async (userId, args, allowFailure = false) => {
    const { home } = ensureUserHome(dataDir, userId);
    const prepared = await execution.prepare({ command: { type: 'argv', file: 'git', args: ['config', '--file', join(home, '.gitconfig'), ...args] }, cwd: home, leaseKind: 'terminal' }, { roots: [home], accountUserId: userId });
    return runPrepared(prepared, { allowFailure, outputCap: 64_000 });
  };

  const readAuthor = async (userId) => {
    const name = await gitConfig(userId, ['--get', 'user.name'], true);
    const email = await gitConfig(userId, ['--get', 'user.email'], true);
    return { name: name.code === 0 ? name.output.trim() : '', email: email.code === 0 ? email.output.trim() : '' };
  };

  const environmentState = async (req) => {
    const userId = requireUser(req);
    const homeState = ensureUserHome(dataDir, userId);
    const probe = bubblewrapProbe();
    const owner = ctx.currentIdentity()?.owner === true;
    const mode = owner || ctx.config.confineNonOperators === false ? 'direct' : probe.available ? 'confined' : 'unavailable';
    const size = directorySize(homeState.home);
    const author = await readAuthor(userId);
    const leases = activeExecutionLeases(db, { accountUserId: userId, homeGeneration: homeState.generation });
    return {
      mode,
      probe,
      networkAvailable: mode === 'confined',
      home: { path: homeState.home, generation: homeState.generation, ...size, activeProcesses: leases.length },
      author,
      migrationCollision: migrationState.collisions.some((collision) => collision.userId === userId),
    };
  };

  register('environment', 'GET', async (req) => json(await environmentState(req)));

  register('environment/author', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const name = String(input.name ?? '').trim();
    const email = String(input.email ?? '').trim();
    if (!name || name.length > 120) throw Object.assign(new Error('Git author name must be 1-120 characters'), { code: 'invalid_author_name', status: 400 });
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw Object.assign(new Error('a valid Git author email is required'), { code: 'invalid_author_email', status: 400 });
    await gitConfig(userId, ['user.name', name]);
    await gitConfig(userId, ['user.email', email]);
    return json({ author: { name, email } });
  });

  register('environment/reset-preview', 'POST', async (req) => {
    const state = await environmentState(req);
    const phrase = 'RESET HOME';
    const payload = {
      generation: state.home.generation,
      bytes: state.home.bytes,
      entries: state.home.entries,
      activeProcesses: state.home.activeProcesses,
      author: state.author,
    };
    return json({ ...payload, phrase, previewHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  });

  register('environment/reset', 'POST', async (req) => {
    const userId = requireUser(req);
    const input = await body(req);
    const state = await environmentState(req);
    const payload = {
      generation: state.home.generation,
      bytes: state.home.bytes,
      entries: state.home.entries,
      activeProcesses: state.home.activeProcesses,
      author: state.author,
    };
    const currentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (String(input.previewHash ?? '') !== currentHash) throw Object.assign(new Error('HOME changed since the reset preview'), { code: 'home_changed', status: 409 });
    if (String(input.phrase ?? '') !== 'RESET HOME') throw Object.assign(new Error('the typed confirmation phrase does not match'), { code: 'confirmation_mismatch', status: 400 });
    const reset = await withRepoLease(db, `home:${userId}`, () => resetUserHome({ db, dataDir, userId, expectedGeneration: state.home.generation }));
    return json(reset);
  });
}
