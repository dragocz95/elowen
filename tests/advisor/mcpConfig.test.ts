import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpConfig, codexMcpArgs } from '../../src/advisor/mcpConfig.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-mcp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeMcpConfig', () => {
  it('claude → .mcp.json with an http orca server and bearer header', () => {
    writeMcpConfig('claude-code', dir, 'tok', 'http://localhost:4600/mcp');
    const cfg = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(cfg.mcpServers.orca.url).toBe('http://localhost:4600/mcp');
    expect(cfg.mcpServers.orca.headers.Authorization).toBe('Bearer tok');
  });

  it('opencode → opencode.json with a remote mcp server', () => {
    writeMcpConfig('opencode', dir, 'tok', 'http://localhost:4600/mcp');
    const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
    expect(cfg.mcp.orca.type).toBe('remote');
    expect(cfg.mcp.orca.url).toBe('http://localhost:4600/mcp');
    expect(cfg.mcp.orca.headers.Authorization).toBe('Bearer tok');
    expect(cfg.mcp.orca.enabled).toBe(true);
  });

  it('codex → writes NO project-local file (codex only reads $CODEX_HOME/config.toml)', () => {
    // codex-cli 0.98 ignores any project-local config, so a dropped file would be dead. Its MCP server
    // is wired at launch via codexMcpArgs instead — see the codexMcpArgs cases below.
    writeMcpConfig('codex', dir, 'tok', 'http://localhost:4600/mcp');
    expect(existsSync(join(dir, '.codex-mcp.toml'))).toBe(false);
    expect(existsSync(join(dir, 'config.toml'))).toBe(false);
  });

  it('an unknown program writes nothing', () => {
    writeMcpConfig('something-else', dir, 'tok', 'http://x/mcp');
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
  });
});

describe('codexMcpArgs', () => {
  it('codex → `-c` overrides for url and a bearer-token env var (no secret on the command line)', () => {
    const args = codexMcpArgs('codex', 'http://localhost:4600/mcp');
    // Values are parsed as TOML by codex, hence the inner quotes. Verified against codex-cli 0.98:
    // `codex -c 'mcp_servers.orca.url=…' -c 'mcp_servers.orca.bearer_token_env_var="ORCA_TOKEN"' mcp list`
    // lists orca as an enabled streamable_http server.
    expect(args).toEqual([
      '-c', 'mcp_servers.orca.url="http://localhost:4600/mcp"',
      '-c', 'mcp_servers.orca.bearer_token_env_var="ORCA_TOKEN"',
    ]);
  });

  it('non-codex programs get no launch args (they use a config file instead)', () => {
    expect(codexMcpArgs('claude-code', 'http://x/mcp')).toEqual([]);
    expect(codexMcpArgs('opencode', 'http://x/mcp')).toEqual([]);
    expect(codexMcpArgs('something-else', 'http://x/mcp')).toEqual([]);
  });
});
