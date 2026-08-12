/** Env var the spawned CLI reads its bearer token from. The spawn layer delivers it as tmux session
 *  env, so codex can reference it by name instead of baking the secret onto the command line. */
const TOKEN_ENV = 'ELOWEN_TOKEN';

/** Extra launch args that wire the elowen MCP server into a `codex` invocation. Codex reads MCP servers
 *  only from `$CODEX_HOME/config.toml`, so the server is injected via `-c` config overrides (the value
 *  is parsed as TOML, hence the inner quoting). The bearer token is read at runtime from the
 *  `ELOWEN_TOKEN` env var via `bearer_token_env_var`, so no secret lands on the command line. Verified
 *  against codex-cli 0.98 (`codex -c 'mcp_servers.elowen.url=…' mcp list` → elowen enabled,
 *  transport streamable_http). Returns `[]` for non-codex programs, which use a config file instead
 *  (written by advisor/mcpConfig.ts before launch). This is the single owner of the codex wiring. */
export function codexMcpArgs(program: string, mcpUrl: string): string[] {
  if (!program.startsWith('codex')) return [];
  return [
    '-c', `mcp_servers.elowen.url="${mcpUrl}"`,
    '-c', `mcp_servers.elowen.bearer_token_env_var="${TOKEN_ENV}"`,
  ];
}
