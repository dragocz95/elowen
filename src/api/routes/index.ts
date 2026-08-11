import type { ElowenApp, RouteContext } from '../context.js';
import { registerAuthGuards } from '../middleware.js';
import { registerAuthRoutes } from './auth.js';
import { registerProjectRoutes } from './projects.js';
import { registerActivityRoutes } from './activity.js';
import { registerSessionRoutes } from './sessions.js';
import { registerAdvisorRoutes } from './advisor.js';
import { registerBrainRoutes } from './brain.js';
import { registerIntegrationRoutes } from './integrations.js';
import { registerMissionRoutes } from './missions.js';
import { registerConfigRoutes } from './config.js';
import { registerPluginRoutes } from './plugins/index.js';
import { registerTaskRoutes } from './tasks.js';
import { registerMemoryRoutes } from './memory.js';
import { registerHookRoutes } from './hooks.js';
import { registerPluginApiRoutes, registerRootPluginApiRoutes } from './pluginApi.js';
import { registerPluginUiRoutes } from './pluginUi.js';

/** Register every route family on the app. Order matters: the auth/tenancy guards are global
 *  middleware and MUST register before any family so every downstream handler is authenticated and
 *  gated. Families register distinct paths, so their relative order is otherwise immaterial. */
export function registerRoutes(app: ElowenApp, ctx: RouteContext): void {
  registerAuthGuards(app, ctx);
  registerAuthRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerActivityRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerAdvisorRoutes(app, ctx);
  registerBrainRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerMissionRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  // BEFORE the admin plugin family: `/plugins/ui` must win over its `/plugins/:name` param route (Hono
  // matches in registration order), and the bundle route is user-authed while that family is admin.
  registerPluginUiRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
  // Authenticated plugin API dispatcher — the `/api/` segment keeps it disjoint from the core
  // `/plugins/:name/...` admin routes registered just above.
  registerPluginApiRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerHookRoutes(app, ctx);
  // ROOT-mounted plugin routes — MUST register last: it is a fallback catch-all, so a core route
  // registered above always wins over a plugin's root mount by construction.
  registerRootPluginApiRoutes(app, ctx);
}
