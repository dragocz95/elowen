const ENVIRONMENT_PATH = /^\/?([1-9][0-9]*)\/environment$/;
const REQUEST_ID = /^[a-zA-Z0-9_.:-]{1,160}$/;
const failure = (cause) => ({ status: cause.status ?? 500, body: { error: cause.code ?? 'environment_error', detail: cause.message } });
const bad = (message, code = 'invalid_body') => Object.assign(new Error(message), { code, status: 400 });

/** UI environment surface: exact GET/POST `/plugins/sandbox/api/projects/:id/environment`. The registry
 *  hands the handler only the remainder after the namespaced `projects` mount. GET is a read-only
 *  overview that can never provision; POST accepts ONLY an action/requestId/expectedGeneration body and
 *  returns the durable EnvironmentOperation. Scope is the verified actor plus accessibleProjects, with
 *  one lifecycle exception: a Project that is already DELETING may still be driven by its managers, so
 *  a failed deletion can be retried; an active Project excluded from the scope stays forbidden. */
export function registerEnvironmentApi(ctx, runtime) {
  const control = runtime?.control ?? runtime;
  const stores = () => ctx.host.stores();
  const register = (path, method, handler) => ctx.registerApiRoute({ path, method, access: 'user', handler: async (req) => {
    try { return { status: 200, body: await handler(req) }; }
    catch (cause) { return failure(cause); }
  } });
  const projectId = (req) => {
    const match = ENVIRONMENT_PATH.exec(req.path ?? '');
    if (!match) throw Object.assign(new Error('Unknown environment route'), { code: 'not_found', status: 404 });
    return Number(match[1]);
  };
  const account = (req) => {
    const accountUserId = req.auth?.userId;
    if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) throw Object.assign(new Error('A linked Elowen account is required'), { code: 'account_required', status: 401 });
    return accountUserId;
  };
  const scope = (req, id, accountUserId) => {
    const accessible = req.auth?.accessibleProjects;
    if (accessible === null || accessible === undefined) return;
    if (accessible.includes(id)) return;
    const project = stores().projects.get(id);
    if (project?.lifecycle === 'deleting' && stores().userProjects.canManage(accountUserId, id)) return;
    throw Object.assign(new Error('Project access is denied'), { code: 'project_forbidden', status: 403 });
  };

  register('projects', 'GET', async (req) => {
    const id = projectId(req);
    const accountUserId = account(req);
    scope(req, id, accountUserId);
    return await control.projectOverview({ project: { kind: 'managed', projectId: id }, accountUserId });
  });
  register('projects', 'POST', async (req) => {
    const id = projectId(req);
    const accountUserId = account(req);
    scope(req, id, accountUserId);
    let input;
    try { input = await req.json(); }
    catch { throw bad('JSON object body required'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('JSON object body required');
    if (Object.keys(input).some((key) => !['action', 'requestId', 'expectedGeneration'].includes(key))) throw bad('Only action, requestId and expectedGeneration are accepted');
    if (!input.action || typeof input.action !== 'object' || Array.isArray(input.action)) throw bad('An environment action is required');
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId))) throw bad('Invalid idempotency key');
    if (input.expectedGeneration !== undefined && !Number.isSafeInteger(input.expectedGeneration)) throw bad('Invalid expected generation');
    return await control.requestEnvironment({ project: { kind: 'managed', projectId: id }, accountUserId, action: input.action,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }) });
  });

  // Legacy per-environment surfaces, contract unchanged. Accepts either the full runtime or its control.
  const legacy = (path, method, handler) => ctx.registerApiRoute({ path: `environments/${path}`, method, access: 'user', handler: async (req) => {
    try {
      const accountUserId = req.auth.userId;
      if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) return { status: 401, body: { error: 'account_required' } };
      const input = method === 'GET' ? req.query : await req.json();
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 400, body: { error: 'invalid_body' } };
      const project = { kind: 'managed', projectId: Number(input.projectId) };
      if (path !== 'operation' && req.auth.accessibleProjects !== null && !req.auth.accessibleProjects.includes(project.projectId)) return { status: 403, body: { error: 'project_forbidden' } };
      return { status: 200, body: await handler(input, { project, accountUserId }) };
    } catch (cause) { return failure(cause); }
  } });
  legacy('status', 'GET', (input, actor) => control.environmentFor(actor));
  legacy('request', 'POST', (input, actor) => control.requestEnvironment({ ...actor, action: input.action, expectedGeneration: input.expectedGeneration, requestId: input.requestId }));
  legacy('operation', 'GET', (input, actor) => control.environmentOperation({ accountUserId: actor.accountUserId, operationId: input.operationId }));
  legacy('snapshots', 'GET', (input, actor) => control.environmentSnapshots(actor));
  legacy('logs', 'GET', (input, actor) => control.environmentLogs({ ...actor, ...(input.lines === undefined ? {} : { lines: Number(input.lines) }) }));
  legacy('files', 'POST', (input, actor) => control.projectFiles({ ...actor, operation: input.operation, expectedGeneration: input.expectedGeneration }));
  legacy('worktrees', 'POST', (input, actor) => control.managedWorktrees({ ...actor, action: input.action }));
}