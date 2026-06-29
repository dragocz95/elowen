import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Env var the spawned advisor CLI reads its bearer token from. The spawn layer exports it
 *  (`export ORCA_TOKEN=…`) before launching the CLI, so codex can reference it by name instead of
 *  baking the secret onto the command line. */
const TOKEN_ENV = 'ORCA_TOKEN';

/** Write the per-program MCP config into the advisor session's cwd so the spawned CLI auto-connects
 *  to Orca's MCP server. Each CLI has its own mechanism — claude reads `.mcp.json`, opencode reads
 *  `opencode.json` (both auto-loaded from cwd, verified against claude-code and opencode 1.17). Codex
 *  is the exception: it reads MCP servers ONLY from `$CODEX_HOME/config.toml`, never a project-local
 *  file (verified against codex-cli 0.98), so it is wired at launch via `-c` flags — see
 *  `codexMcpArgs` / commandBuilder — and writes no file here. The `orca api` CLI verb is the
 *  always-available fallback, so an imperfect MCP wiring degrades gracefully. */
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
  }
  // codex: no file — it ignores project-local config, so its orca server is injected via codexMcpArgs.
}

/** Extra launch args that wire the orca MCP server into a `codex` invocation. Codex reads MCP servers
 *  only from `$CODEX_HOME/config.toml`, so the server is injected via `-c` config overrides (the value
 *  is parsed as TOML, hence the inner quoting). The bearer token is read at runtime from the
 *  `ORCA_TOKEN` env var via `bearer_token_env_var`, so no secret lands on the command line. Verified
 *  against codex-cli 0.98 (`codex -c 'mcp_servers.orca.url=…' mcp list` → orca enabled,
 *  transport streamable_http). Returns `[]` for non-codex programs, which use a config file instead. */
export function codexMcpArgs(program: string, mcpUrl: string): string[] {
  if (!program.startsWith('codex')) return [];
  return [
    '-c', `mcp_servers.orca.url="${mcpUrl}"`,
    '-c', `mcp_servers.orca.bearer_token_env_var="${TOKEN_ENV}"`,
  ];
}
