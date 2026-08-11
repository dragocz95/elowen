/** agents — the tmux-agent + missions subsystem as a plugin (plugin-platform F2).
 *
 *  Extraction in progress: the store layer lives here (step 3); spawn/deriver/overseer, API routes,
 *  prompts and brain tools follow step by step. Runtime reach comes exclusively through the
 *  PluginContext (ctx.host.*, ctx.db(), ctx.publishEvent(), ctx.registerPrompts(), …); imports from
 *  the daemon's src/ are TYPE-ONLY and erase at compile time, so the built plugin has no runtime
 *  dependency on the daemon's module graph.
 */
import type { PluginContext } from '../../../src/plugins/api.js';
import { AGENTS_MIGRATIONS } from './store/migrations.js';

export function register(ctx: PluginContext): void {
  // Schema first: grandfathered tables (see store/migrations.ts). In the daemon this applies pending
  // steps exactly once; in the sub-agent runner ctx.db().migrate() is a logged no-op by design.
  ctx.db().migrate(AGENTS_MIGRATIONS);
  ctx.logger.info('agents plugin loaded (store layer)');
}
