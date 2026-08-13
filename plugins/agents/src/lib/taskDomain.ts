import type { PluginContext } from '../../../../src/plugins/api.js';

/** Missions ARE tasks: an epic with phases, spawned agents, a review gate on each phase. The rows live
 *  in the `tasks` domain, which another plugin owns, so this subsystem has a hard runtime dependency it
 *  cannot fake. When that domain has no owner the honest answer is a refusal — never an empty mission
 *  list, never a half-built runtime that throws mid-request. One sentence, used by every surface. */
export const MISSIONS_WITHOUT_TASKS =
  'missions are unavailable: they are built on task tracking, whose plugin is disabled';

/** Thrown by the runtime accessor rather than letting construction touch the absent domain, so a caller
 *  that forgot to check fails loudly at the seam instead of somewhere inside a mission tick. */
export class TaskDomainUnavailableError extends Error {
  constructor() {
    super(MISSIONS_WITHOUT_TASKS);
    this.name = 'TaskDomainUnavailableError';
  }
}

/** The same PluginContext with ONE method wrapped: every API route registered through it answers 503
 *  while the task domain has no owner, without reaching its handler (and therefore without building the
 *  runtime). Central on purpose — a gate spread across seven route modules is a gate a new route forgets.
 *
 *  A Proxy rather than a spread copy: the context is the host's object and keeps behaving like it,
 *  including anything added to it later. */
export function gateRoutesOnTaskDomain(ctx: PluginContext, available: () => boolean): PluginContext {
  const registerApiRoute: PluginContext['registerApiRoute'] = (route) => {
    ctx.registerApiRoute({
      ...route,
      handler: async (req) => (available()
        ? route.handler(req)
        : { status: 503, body: { error: MISSIONS_WITHOUT_TASKS } }),
    });
  };
  return new Proxy(ctx, {
    get: (target, prop, receiver) => (prop === 'registerApiRoute' ? registerApiRoute : Reflect.get(target, prop, receiver)),
  });
}
