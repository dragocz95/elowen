import type { OrcaApp, RouteContext } from '../context.js';
import { registerAuthGuards } from '../middleware.js';
import { registerAuthRoutes } from './auth.js';

/** Register every route family on the app. Order matters: the auth/tenancy guards are global
 *  middleware and MUST register before any family so every downstream handler is authenticated and
 *  gated. Families are migrated here one at a time; any not yet extracted stay inline in
 *  `createServer` and register after this call (still after the guards). */
export function registerRoutes(app: OrcaApp, ctx: RouteContext): void {
  registerAuthGuards(app, ctx);
  registerAuthRoutes(app, ctx);
}
