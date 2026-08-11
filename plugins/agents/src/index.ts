/** agents — the tmux-agent + missions subsystem as a plugin (plugin-platform F2).
 *
 *  SKELETON: establishes the TypeScript plugin build (tsc → dist/, shipped with the repo in lockstep)
 *  and the capability envelope before any core code moves in. Runtime reach comes exclusively through
 *  the PluginContext (ctx.host.*, ctx.db(), ctx.publishEvent(), ctx.registerPrompts(), …); imports
 *  from the daemon's src/ are TYPE-ONLY and erase at compile time, so the built plugin has no runtime
 *  dependency on the daemon's module graph.
 */
import type { PluginContext } from '../../../src/plugins/api.js';

export function register(ctx: PluginContext): void {
  // Nothing contributes yet — the extraction lands here step by step (stores → spawn/deriver/overseer
  // → API routes/services → prompts/tools). The skeleton only proves the build + load path.
  ctx.logger.info('agents plugin skeleton loaded');
}
