import type { OrcaApp, RouteContext } from '../context.js';
import { registerAuthGuards } from '../middleware.js';
import { registerAuthRoutes } from './auth.js';
import { registerProjectRoutes } from './projects.js';
import { registerActivityRoutes } from './activity.js';
import { registerIntegrationRoutes } from './integrations.js';
import { registerSessionRoutes } from './sessions.js';
import { registerAdvisorRoutes } from './advisor.js';
import { registerBrainRoutes } from './brain.js';
import { registerMissionRoutes } from './missions.js';
import { registerConfigRoutes } from './config.js';
import { registerPluginRoutes } from './plugins.js';
import { registerTaskRoutes } from './tasks.js';

/** Register every route family on the app. Order matters: the auth/tenancy guards are global
 *  middleware and MUST register before any family so every downstream handler is authenticated and
 *  gated. Families register distinct paths, so their relative order is otherwise immaterial. */
export function registerRoutes(app: OrcaApp, ctx: RouteContext): void {
  registerAuthGuards(app, ctx);
  registerAuthRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerActivityRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerAdvisorRoutes(app, ctx);
  registerBrainRoutes(app, ctx);
  registerMissionRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
}
