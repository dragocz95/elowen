import { isRequestId } from './environmentDb.mjs';

const ENVIRONMENT_PATH = /^\/?([1-9][0-9]*)\/environment$/;
const failure = (cause) => ({ status: cause.status ?? 500, body: { error: cause.code ?? 'environment_error', detail: cause.message } });
const bad = (message, code = 'invalid_body') => Object.assign(new Error(message), { code, status: 400 });

/** UI environment surface: exact GET/POST `/plugins/sandbox/api/projects/:id/environment`. The registry
 *  hands the handler only the remainder after the namespaced `projects` mount. GET is a read-only
 *  overview that can never provision; POST accepts ONLY an action/requestId/expectedGeneration body and
 *  returns the durable EnvironmentOperation. Scope is the verified actor plus accessibleProjects; the
 *  runtime resolves membership again for itself, so this is a gate rather than the decision. */
export function registerEnvironmentApi(ctx, runtime) {
  const control = runtime?.control ?? runtime;
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
  // The caller's accessible projects are their ASSIGNMENTS, which a project keeps while it is deleting,
  // so its managers are already inside this scope and need no exception. Membership itself is resolved
  // again, freshly, inside the runtime's own authorization.
  const scope = (req, id) => {
    const accessible = req.auth?.accessibleProjects;
    if (accessible === null || accessible === undefined || accessible.includes(id)) return;
    throw Object.assign(new Error('Project access is denied'), { code: 'project_forbidden', status: 403 });
  };

  register('projects', 'GET', async (req) => {
    const id = projectId(req);
    const accountUserId = account(req);
    scope(req, id);
    return await control.projectOverview({ project: { kind: 'managed', projectId: id }, accountUserId });
  });
  register('projects', 'POST', async (req) => {
    const id = projectId(req);
    const accountUserId = account(req);
    scope(req, id);
    let input;
    try { input = await req.json(); }
    catch { throw bad('JSON object body required'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('JSON object body required');
    if (Object.keys(input).some((key) => !['action', 'requestId', 'expectedGeneration'].includes(key))) throw bad('Only action, requestId and expectedGeneration are accepted');
    if (!input.action || typeof input.action !== 'object' || Array.isArray(input.action)) throw bad('An environment action is required');
    if (input.requestId !== undefined && !isRequestId(input.requestId)) throw bad('Invalid idempotency key');
    if (input.expectedGeneration !== undefined && !Number.isSafeInteger(input.expectedGeneration)) throw bad('Invalid expected generation');
    return await control.requestEnvironment({ project: { kind: 'managed', projectId: id }, accountUserId, action: input.action,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }) });
  });

  // The Project register reads every visible managed row in one request. The API scope rejects the whole
  // batch before the runtime touches a row, then the runtime re-resolves each membership against current
  // state so a revoked assignment cannot keep reading host resource counters through a stale browser list.
  ctx.registerApiRoute({ path: 'environments/usage', method: 'POST', access: 'user', handler: async (req) => {
    try {
      const accountUserId = req.auth?.userId;
      if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) return { status: 401, body: { error: 'account_required' } };
      let input;
      try { input = await req.json(); }
      catch { throw bad('JSON object body required', 'invalid_project_ids'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'projectIds')) throw bad('A Project id list is required', 'invalid_project_ids');
      const projectIds = input.projectIds;
      if (!Array.isArray(projectIds) || projectIds.length < 1 || projectIds.length > 1000 || new Set(projectIds).size !== projectIds.length
        || projectIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw bad('A bounded list of unique Project ids is required', 'invalid_project_ids');
      const accessible = req.auth?.accessibleProjects;
      if (accessible !== null && accessible !== undefined && projectIds.some((id) => !accessible.includes(id))) return { status: 403, body: { error: 'project_forbidden' } };
      return { status: 200, body: await runtime.environmentUsageBatch({ projectIds, accountUserId }) };
    } catch (cause) { return failure(cause); }
  } });

  // The remaining per-environment reads serve the detail surfaces and one operation's live state. Both take
  // their input from the query string; everything a surface WRITES goes through the namespaced mount above.
  const read = (path, handler) => ctx.registerApiRoute({ path: `environments/${path}`, method: 'GET', access: 'user', handler: async (req) => {
    try {
      const accountUserId = req.auth.userId;
      if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) return { status: 401, body: { error: 'account_required' } };
      const input = req.query;
      const project = { kind: 'managed', projectId: Number(input.projectId) };
      if (path !== 'operation' && req.auth.accessibleProjects !== null && !req.auth.accessibleProjects.includes(project.projectId)) return { status: 403, body: { error: 'project_forbidden' } };
      return { status: 200, body: await handler(input, { project, accountUserId }) };
    } catch (cause) { return failure(cause); }
  } });
  read('status', (input, actor) => control.environmentFor(actor));
  read('operation', (input, actor) => control.environmentOperation({ accountUserId: actor.accountUserId, operationId: input.operationId }));

  // What the host still owes the machine runtime, and the one request that repairs it. Both are
  // administrator-only and the runtime re-checks that for itself; this is a gate, not the decision.
  // GET is side-effect free and safe to poll. POST installs packages, writes root-owned unit, polkit and
  // sysctl files and applies firewall rules, so it is deliberately a separate verb on a separate route
  // rather than a flag on the read — nothing a browser does by merely LOOKING can change the host.
  const machine = (method, handler) => ctx.registerApiRoute({ path: 'runtime/host', method, access: 'admin', handler: async (req) => {
    try {
      const accountUserId = req.auth?.userId;
      if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) return { status: 401, body: { error: 'account_required' } };
      return await handler(req, { accountUserId });
    } catch (cause) { return failure(cause); }
  } });
  machine('GET', async (_req, actor) => ({ status: 200, body: await control.machineRuntimeReadiness(actor) }));
  machine('POST', async (req, actor) => {
    let input;
    try { input = await req.json(); }
    catch { throw bad('JSON object body required'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('JSON object body required');
    if (Object.keys(input).some((key) => !['action', 'requestId'].includes(key))) throw bad('Only action and requestId are accepted');
    if (!input.action || typeof input.action !== 'object' || Array.isArray(input.action)
      || Object.keys(input.action).length !== 1 || input.action.kind !== 'provision') throw bad('The provision action is required');
    if (input.requestId !== undefined && !isRequestId(input.requestId)) throw bad('Invalid idempotency key');
    return { status: 202, body: await control.provisionMachineRuntime({ ...actor, action: input.action,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }) }) };
  });
}