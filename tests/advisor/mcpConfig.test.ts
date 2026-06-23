import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpConfig } from '../../src/advisor/mcpConfig.js';

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

  it('codex → a TOML config naming the orca mcp server', () => {
    writeMcpConfig('codex', dir, 'tok', 'http://localhost:4600/mcp');
    const toml = readFileSync(join(dir, '.codex-mcp.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.orca]');
    expect(toml).toContain('http://localhost:4600/mcp');
  });

  it('an unknown program writes nothing', () => {
    writeMcpConfig('something-else', dir, 'tok', 'http://x/mcp');
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
  });
});
