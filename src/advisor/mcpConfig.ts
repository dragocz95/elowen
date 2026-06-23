import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write the per-program MCP config into the advisor session's cwd so the spawned CLI auto-connects
 *  to Orca's MCP server. Each CLI has its own config schema — claude reads `.mcp.json`, opencode reads
 *  `opencode.json`, codex reads a TOML config. The schemas are version-sensitive: VERIFY each against
 *  the installed CLI version's docs. The `orca api` CLI verb is the always-available fallback, so an
 *  imperfect MCP wiring for one program degrades gracefully rather than removing the advisor's reach. */
export function writeMcpConfig(program: string, cwd: string, token: string, mcpUrl: string): void {
  const auth = `Bearer ${token}`;
  // The config carries the advisor's full-scope bearer token, so lock the file to the daemon user (0600).
  const opts = { mode: 0o600 } as const;
  if (program.startsWith('claude')) {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { orca: { type: 'http', url: mcpUrl, headers: { Authorization: auth } } },
    }, null, 2), opts);
  } else if (program.startsWith('opencode')) {
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { orca: { type: 'remote', url: mcpUrl, headers: { Authorization: auth }, enabled: true } },
    }, null, 2), opts);
  } else if (program.startsWith('codex')) {
    // Codex reads MCP servers from its TOML config. Written project-local; VERIFY the exact key/path
    // (and whether the installed codex needs a `--config`/`-c` flag to pick this up) for the version.
    writeFileSync(join(cwd, '.codex-mcp.toml'), `[mcp_servers.orca]\nurl = "${mcpUrl}"\nbearer_token = "${token}"\n`, opts);
  }
}
