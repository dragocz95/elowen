import type { ElowenApp, RouteContext } from '../context.js';
import { registerAuthGuards } from '../middleware.js';
import { registerAuthRoutes } from './auth.js';
import { registerAuthSsoRoutes } from './authSso.js';
import { registerProjectRoutes } from './projects.js';
import { registerActivityRoutes } from './activity.js';
import { registerBrainRoutes } from './brain.js';
import { registerConfigRoutes } from './config.js';
import { registerPluginRoutes } from './plugins/index.js';
import { registerUsageRoutes } from './usage.js';
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
  registerAuthSsoRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerActivityRoutes(app, ctx);
  registerBrainRoutes(app, ctx);
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
  // @platform-keep root-plugin-routes :: registerRootPluginApiRoutes(app, ctx)
  // Generic plugin platform for future github/sandblox consumers; zero in-repo callers is expected.
  // MUST remain last: core routes win over the fallback root mount by construction.
  registerRootPluginApiRoutes(app, ctx);
}
