import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { LspManager, formatCheckResult } from '../../lsp/manager.js';
import { allowedRoots, assertPathAllowed, realPathWithin } from '../../plugins/pathGuard.js';
import { currentWorkDir } from '../../plugins/policyContext.js';

/** One daemon-wide LSP manager (owns the live language-server clients). Shared by the `lsp_diagnostics`
 *  tool and the `/lsp` toggle so enabling/disabling and diagnostics hit the same servers. Lazily built so
 *  no server is spawned until the agent actually checks a file. */
let manager: LspManager | null = null;
export function lspManager(): LspManager {
  if (!manager) manager = new LspManager();
  return manager;
}

/** Current LSP diagnostics state WITHOUT building the manager (it defaults to enabled). Read by
 *  /brain/status so chat clients can show the live Active/Inactive state next to the `/lsp` toggle. */
export function lspEnabled(): boolean {
  return manager ? manager.isEnabled() : true;
}

/** Most-specific current-turn root containing the checked file. This is both the LSP search boundary
 *  and the security boundary: project marker discovery must never walk above a scoped user's repo. */
function lspBoundary(path: string): string | undefined {
  // An allowed repo is the hard security floor. Prefer it over a possibly deeper client cwd so a turn
  // launched from `<repo>/src` can still discover `<repo>/tsconfig.json` without ever reaching outside
  // the repo. All-access turns have no allowed roots, so their validated cwd is the useful fallback.
  const permitted = allowedRoots()
    .filter((root) => realPathWithin(path, [root]) !== null)
    .sort((a, b) => b.length - a.length)[0];
  if (permitted) return permitted;
  const workDir = currentWorkDir();
  return workDir && realPathWithin(path, [workDir]) !== null ? workDir : undefined;
}

/** The `/lsp` toggle: flip live diagnostics on/off and report the new state. Off frees every spawned
 *  server. Shared by the CLI `/lsp` command via the /brain/command dispatch. */
export function toggleLsp(): { enabled: boolean; message: string } {
  const mgr = lspManager();
  const enabled = !mgr.isEnabled();
  mgr.setEnabled(enabled);
  return { enabled, message: enabled ? 'LSP diagnostics ON — the agent can now type-check edits live.' : 'LSP diagnostics OFF — language servers stopped.' };
}

/** The owner-chat LSP toolset: an on-demand "did I break it?" probe the agent runs after editing a code
 *  file. Read-only (reads the file, queries its language server) → plan-mode safe. */
export function buildLspTools() {
  return [
    defineTool({
      name: 'lsp_diagnostics', label: 'Check diagnostics',
      description: 'Type-check a file with its language server (LSP) and return errors/warnings with exact line:column. Call this right after editing a code file to immediately confirm it still compiles. Returns "no problems" for a clean file, and a clear note when LSP is off (/lsp) or no server is installed for the language.',
      parameters: Type.Object({ path: Type.String({ description: 'Absolute path to the file to check' }) }),
      execute: async (_id: string, p: { path: string }) => {
        // Same per-user path policy as every other file tool — without it a user scoped to one project
        // could feed ANY file on disk to a language server and read its content back through quoted
        // diagnostics. Reject with a plain error text (tools report, they don't throw).
        let path: string;
        try { path = assertPathAllowed(p.path); }
        catch (e) { return { content: [{ type: 'text' as const, text: `LSP: ${(e as Error).message}` }], details: {} }; }
        const result = await lspManager().checkFile(path, lspBoundary(path));
        const text = formatCheckResult(result) || `LSP: nothing to check for ${p.path}.`;
        return { content: [{ type: 'text' as const, text }], details: {} };
      },
    }),
  ];
}
