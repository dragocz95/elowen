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

  // The two per-environment reads a browser makes: one row's state, for a project register that lists
  // many, and one operation's live state, for the shared progress window. Both take their input from the
  // query string; everything a surface WRITES goes through the namespaced projects mount above.
  const read = (path, handler) => ctx.registerApiRoute({ path: `environments/${path}`, method: 'GET', access: 'user', handler: async (req) => {
    try {
      const accountUserId = req.auth.userId;
      if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) return { status: 401, body: { error: 'account_required' } };
      const input = req.query ?? {};
      const project = { kind: 'managed', projectId: Number(input.projectId) };
      if (path !== 'operation' && req.auth.accessibleProjects !== null && !req.auth.accessibleProjects.includes(project.projectId)) return { status: 403, body: { error: 'project_forbidden' } };
      return { status: 200, body: await handler(input, { project, accountUserId }) };
    } catch (cause) { return failure(cause); }
  } });
  read('status', (input, actor) => control.environmentFor(actor));
  read('operation', (input, actor) => control.environmentOperation({ accountUserId: actor.accountUserId, operationId: input.operationId }));
}