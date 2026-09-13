// The sandbox plugin's own endpoints, as the environment surfaces read and write them
// (`GET/POST /plugins/sandbox/api/projects/:id/environment` plus the operation reads). Separate from
// `pluginSurfaces.ts` because this one is not a canned answer: the environment is a WRITING surface, so
// the fake keeps state — the running state, its limits and the operations it has accepted.
//
// WHAT IT MODELS, and why each piece is there:
//   - one project environment whose limits are STATE, not a canned answer, because the resource rows
//     auto-save through a durable lifecycle action and a spec has to see the figure it moved come back
//     on the next poll, exactly as the running container reports it;
//   - the `stop` / `start` / `restart` / `recreate` / `limits` actions the daemon accepts, applied
//     immediately so the next read shows the new state.
//
// WHAT IT DOES NOT PROVE: the shapes are structural mirrors of the plugin's wire types
// (src/plugins/environmentTypes.ts), not the plugin's server code. They make the panels verifiable; the
// plugin's own tests own its routes.
import type { Hono } from 'hono';

/** The project environment behind the panels. Its limits are STATE, not a canned answer: the resource
 *  rows auto-save through a durable lifecycle action, so a spec has to be able to see the figure it moved
 *  come back on the next poll, exactly as the running container reports it. */
const seedLimits = () => ({ cpus: 1, memoryMb: 1024, pidsLimit: 512 });
let environmentLimits = seedLimits();
let environmentState: 'running' | 'stopped' | 'failed' = 'running';
let environmentLastError: string | null = null;
const environmentOperations = new Map<string, Record<string, unknown>>();

/** Restore the seed environment and drop the recorded operations (the control channel's `/__test/reset`). */
export function resetSandbox(): void {
  environmentLimits = seedLimits();
  environmentState = 'running';
  environmentLastError = null;
  environmentOperations.clear();
}

export function registerSandboxRoutes(app: Hono): void {
  const environment = (projectId: number) => ({
    projectId, generation: 2, state: environmentState, desiredState: environmentState === 'stopped' ? 'stopped' : 'running',
    lastError: environmentLastError, limits: environmentLimits,
  });
  app.get('/plugins/sandbox/api/projects/:id/environment', (c) => c.json({
    environment: environment(Number(c.req.param('id'))), snapshots: [], operations: [...environmentOperations.values()],
  }));
  app.get('/plugins/sandbox/api/environments/status', (c) => c.json(environment(Number(c.req.query('projectId') ?? 0))));
  app.get('/plugins/sandbox/api/environments/operation', (c) => c.json(environmentOperations.get(c.req.query('operationId') ?? '') ?? null));
  app.post('/__test/sandbox-environment', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { state?: typeof environmentState; lastError?: string | null };
    if (body.state) environmentState = body.state;
    if ('lastError' in body) environmentLastError = body.lastError ?? null;
    return c.json(environment(1));
  });

  // The resource change the rows auto-save. The real plugin answers with a pending operation and applies
  // the figures to the container; the fake applies them immediately so the next read shows the new state.
  app.post('/plugins/sandbox/api/projects/:id/environment', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { action?: { kind?: string; limits?: typeof environmentLimits }; requestId?: string };
    if (body.action?.kind === 'limits' && body.action.limits) environmentLimits = { ...body.action.limits };
    if (body.action?.kind === 'stop') environmentState = 'stopped';
    if (['start', 'restart', 'recreate'].includes(body.action?.kind ?? '')) { environmentState = 'running'; environmentLastError = null; }
    const operation = {
      id: `op-${body.action?.kind ?? 'unknown'}`, requestId: body.requestId ?? 'op', projectId: Number(c.req.param('id')),
      accountUserId: 1, generation: 2, action: body.action ?? { kind: 'unknown' }, status: 'succeeded', error: null, logTail: [],
    };
    environmentOperations.set(operation.id, operation);
    return c.json(operation);
  });
}
