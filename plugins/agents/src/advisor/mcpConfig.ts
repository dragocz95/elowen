import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write the per-program MCP config into the advisor session's cwd so the spawned CLI auto-connects
 *  to Elowen's MCP server. Each CLI has its own mechanism — claude reads `.mcp.json`, opencode reads
 *  `opencode.json` (both auto-loaded from cwd, verified against claude-code and opencode 1.17). Codex
 *  is the exception: it reads MCP servers ONLY from `$CODEX_HOME/config.toml`, never a project-local
 *  file (verified against codex-cli 0.98), so it is wired at launch via `-c` flags — see
 *  `codexMcpArgs` / commandBuilder — and writes no file here. The `elowen api` CLI verb is the
 *  always-available fallback, so an imperfect MCP wiring degrades gracefully. */
export function writeMcpConfig(program: string, cwd: string, token: string, mcpUrl: string): void {
  const auth = `Bearer ${token}`;
  // The config carries the advisor's full-scope bearer token, so lock the file to the daemon user (0600).
  const opts = { mode: 0o600 } as const;
  if (program.startsWith('claude')) {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { elowen: { type: 'http', url: mcpUrl, headers: { Authorization: auth } } },
    }, null, 2), opts);
  } else if (program.startsWith('opencode')) {
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { elowen: { type: 'remote', url: mcpUrl, headers: { Authorization: auth }, enabled: true } },
    }, null, 2), opts);
  }
  // codex: no file — it ignores project-local config, so its elowen server is injected at launch by
  // the spawn layer's `codexMcpArgs` (lib/mcpArgs.ts), the single owner of that wiring.
}
