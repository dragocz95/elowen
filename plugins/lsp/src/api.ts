import type { PluginApiRequest, PluginContext, PluginHttpResponse } from '../../../src/plugins/api.js';
import type { LspManager } from './manager.js';
import { npmInstallGlobal, npmUninstallGlobal } from './install.js';
import { commandExists, listServers } from './servers.js';

/** The grandfathered `/brain/lsp*` surface, root-mounted so the URLs the CLI and any script already
 *  call keep working after the extraction:
 *   - GET  /brain/lsp            — health at a glance (enabled/running + a row per registry server)
 *   - POST /brain/lsp/install    — install an npm-canonical server into Elowen's own prefix
 *   - POST /brain/lsp/uninstall  — remove one from that prefix
 *  With the plugin disabled the daemon answers 503 `{"error":"lsp plugin is disabled"}` on all three
 *  (declared-but-inactive root mounts), so a caller can tell "subsystem off" from "no such endpoint". */
export function registerLspApi(ctx: PluginContext, manager: () => LspManager | null): void {
  // Exact-mount only: the resolver hands longer paths here as `req.path`, and there is no sub-resource.
  const exact = (req: PluginApiRequest, run: () => Promise<PluginHttpResponse>): Promise<PluginHttpResponse> =>
    req.path === '' ? run() : Promise.resolve({ status: 404, body: { error: 'not found' } });

  /** The `command` field of an install/uninstall body, validated at the trust boundary. */
  const requestedCommand = async (req: PluginApiRequest): Promise<string | null> => {
    const body = await req.json<{ command?: unknown }>().catch(() => null);
    const command = body?.command;
    return typeof command === 'string' && command.trim() !== '' ? command : null;
  };

  // Read-only for every authenticated user (the toggle stays admin-only, as it always was) — drives the
  // CLI /lsp modal and any panel indicator.
  ctx.registerApiRoute({
    rootMount: '/brain/lsp', path: '', method: 'GET', access: 'user',
    handler: (req) => exact(req, async () => {
      const m = manager();
      // Stopped generation (a reload's stop window): say "unavailable", never invent a status.
      return m ? { status: 200, body: m.status() } : { status: 503, body: { error: 'lsp plugin is reloading' } };
    }),
  });

  // Admin-only — it installs software on the host. Only npm-canonical servers are self-installable; the
  // rest 400 with their toolchain's install hint so the caller shows the exact command to run instead.
  ctx.registerApiRoute({
    rootMount: '/brain/lsp/install', path: '', method: 'POST', access: 'admin',
    handler: (req) => exact(req, async () => {
      const command = await requestedCommand(req);
      if (!command) return { status: 400, body: { error: 'command is required' } };
      const spec = listServers().find((s) => s.command === command);
      if (!spec) return { status: 404, body: { error: 'unknown language server' } };
      if (commandExists(spec.command)) return { status: 200, body: { ok: true, message: `${spec.label} is already installed.` } };
      if (!spec.npmPackages?.length) return { status: 400, body: { error: `${spec.label} ships with its toolchain — install it with: ${spec.installHint}` } };
      const r = await npmInstallGlobal(spec.npmPackages);
      if (r.ok && commandExists(spec.command)) return { status: 200, body: { ok: true, message: `${spec.label} installed.` } };
      // npm may "succeed" into a global bin dir that isn't on PATH — report honestly either way.
      return { status: 502, body: { error: r.ok ? `Installed, but ${spec.command} is not on PATH — check the npm global bin directory.` : `Install failed: ${r.detail}` } };
    }),
  });

  // Admin-only, npm-managed servers only; a live client for it is disposed first so nothing keeps
  // running from a removed binary.
  ctx.registerApiRoute({
    rootMount: '/brain/lsp/uninstall', path: '', method: 'POST', access: 'admin',
    handler: (req) => exact(req, async () => {
      const command = await requestedCommand(req);
      if (!command) return { status: 400, body: { error: 'command is required' } };
      const spec = listServers().find((s) => s.command === command);
      if (!spec) return { status: 404, body: { error: 'unknown language server' } };
      if (!spec.npmPackages?.length) return { status: 400, body: { error: `${spec.label} is not managed by Elowen — remove it with your toolchain (installed via: ${spec.installHint}).` } };
      if (!commandExists(spec.command)) return { status: 200, body: { ok: true, message: `${spec.label} is not installed.` } };
      manager()?.disposeAll(); // free any live client before its binary disappears
      const r = await npmUninstallGlobal(spec.npmPackages);
      if (!r.ok) return { status: 502, body: { error: `Uninstall failed: ${r.detail}` } };
      // Still resolvable afterwards = a system copy outside Elowen's prefix; say so instead of "removed".
      return { status: 200, body: { ok: true, message: commandExists(spec.command) ? `${spec.label} removed from Elowen's prefix — a system-installed copy remains on PATH.` : `${spec.label} uninstalled.` } };
    }),
  });
}
