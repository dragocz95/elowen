/** lsp — live language-server diagnostics and code intelligence as a plugin.
 *
 *  The whole subsystem moved out of the daemon core: the LSP wire codec (protocol.ts), the per-server
 *  client (client.ts), the server catalog (servers.ts), the npm installer for Elowen's own server
 *  prefix (install.ts), the client pool (manager.ts), the six brain tools (tools.ts) and the
 *  grandfathered `/brain/lsp*` routes (api.ts). Core keeps no LSP code and no import of it.
 *
 *  Why it is optional: LSP spawns real language servers as CHILD PROCESSES. An operator who does not
 *  want tsserver/pyright/gopls running under their daemon turns the plugin off and gets exactly that —
 *  no tools advertised, no routes, no process.
 *
 *  Lifecycle: the manager is created lazily (nothing spawns until the agent checks a file) and owned by
 *  the registered SERVICE. `stop()` disposes every live client, and the host stops services around a
 *  plugin reload/disable — so a config change or a toggle can no longer leave orphaned language servers
 *  behind, which the pre-extraction daemon-wide singleton did (it lived until the process died).
 */
import type { PluginContext } from '../../../src/plugins/api.js';
import { LspManager } from './manager.js';
import { registerLspTools } from './tools.js';
import { registerLspApi } from './api.js';
import { lspPluginConfig } from './config.js';

/** Test seam, mirroring {@link LspManagerDeps}: the lifecycle test drives real teardown against a fake
 *  transport instead of spawning tsserver. The host only ever calls `register(ctx)`. */
export interface LspRegisterDeps {
  createManager?: () => LspManager;
}

export function register(ctx: PluginContext, deps: LspRegisterDeps = {}): void {
  // Lazy: registration must not spawn anything, and a sub-agent runner loads this plugin too (it gets
  // the tools, never the services) — so the manager appears on the first tool call there.
  const create = deps.createManager ?? (() => new LspManager());
  let manager: LspManager | null = null;
  const lsp = (): LspManager => {
    if (!manager) {
      manager = create();
      manager.setEnabled(lspPluginConfig(ctx.config).diagnosticsEnabled);
    }
    return manager;
  };

  registerLspTools(ctx, lsp);
  registerLspApi(ctx, lsp);

  // The persisted on/off state applies at start, and stop() frees every spawned server. The `/lsp`
  // toggle and the settings form both write plugins.config.lsp.diagnosticsEnabled, which hot-reloads
  // the plugin — so the flip travels through this same stop → start path and kills the servers for real.
  ctx.registerService({
    name: 'diagnostics',
    start: () => {
      const { diagnosticsEnabled } = lspPluginConfig(ctx.config);
      // Seeding through the accessor keeps ONE construction site; when diagnostics are off this makes
      // the state explicit rather than waiting for a first tool call to discover it.
      lsp().setEnabled(diagnosticsEnabled);
      ctx.logger.info(`live diagnostics ${diagnosticsEnabled ? 'on' : 'off'}`);
    },
    stop: () => {
      manager?.disposeAll();
      manager = null;
    },
  });

  // The one thing core still asks this plugin: the live toggle state for GET /brain/status, so chat
  // clients render Active/Inactive. Absent control (plugin disabled) → core omits the field entirely
  // and every client hides its LSP row, which is the honest answer.
  ctx.registerControl('lsp', {
    diagnosticsEnabled: () => lsp().isEnabled(),
  });
}
