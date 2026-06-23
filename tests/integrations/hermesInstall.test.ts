import { describe, it, expect } from 'vitest';
import { mcpEndpoint, orcaServerState, upsertOrcaServer, upsertEnvVar } from '../../src/integrations/hermesInstall.js';

const CONFIG = `# Hermes config
gateway:
  port: 8080
mcp_servers:
  chrome-devtools:
    command: npx
    args:
    - -y
    - chrome-devtools-mcp@latest
    timeout: 120
plugins:
  enabled:
  - example-plugin
`;

describe('mcpEndpoint', () => {
  it('appends /mcp to a base url', () => {
    expect(mcpEndpoint('https://orca.example')).toBe('https://orca.example/mcp');
  });
  it('strips trailing slashes before appending', () => {
    expect(mcpEndpoint('https://orca.example/')).toBe('https://orca.example/mcp');
  });
  it('leaves an url that already ends in /mcp untouched', () => {
    expect(mcpEndpoint('https://orca.example/mcp')).toBe('https://orca.example/mcp');
  });
});

describe('orcaServerState', () => {
  it('reports not registered when orca is absent', () => {
    expect(orcaServerState(CONFIG)).toEqual({ registered: false, enabled: false });
  });
  it('reports registered + enabled once orca is present', () => {
    const state = orcaServerState(upsertOrcaServer(CONFIG, 'https://h/mcp'));
    expect(state).toEqual({ registered: true, enabled: true });
  });
  it('reports disabled when the orca block has enabled: false', () => {
    const text = `mcp_servers:\n  orca:\n    url: "https://h/mcp"\n    enabled: false\n`;
    expect(orcaServerState(text)).toEqual({ registered: true, enabled: false });
  });
});

describe('upsertOrcaServer', () => {
  it('inserts orca under mcp_servers, preserving the rest', () => {
    const text = upsertOrcaServer(CONFIG, 'https://h:4400/mcp');
    expect(text).toContain('  orca:');
    expect(text).toContain('    url: "https://h:4400/mcp"');
    expect(text).toContain('      Authorization: "Bearer ${MCP_ORCA_API_KEY}"');
    expect(text).toContain('chrome-devtools:'); // sibling server kept
    expect(text).toContain('# Hermes config'); // comments survive
    expect(text).toContain('example-plugin'); // unrelated section untouched
    expect(orcaServerState(text)).toEqual({ registered: true, enabled: true });
  });

  it('is idempotent — replacing keeps a single orca block', () => {
    const once = upsertOrcaServer(CONFIG, 'https://h/mcp');
    const twice = upsertOrcaServer(once, 'https://new/mcp');
    expect(twice.match(/^\s{2}orca:\s*$/gm)?.length).toBe(1);
    expect(twice).toContain('    url: "https://new/mcp"'); // url updated
    expect(twice).not.toContain('https://h/mcp');          // old url gone
    expect(twice).toContain('chrome-devtools:');            // sibling still there
  });

  it('creates the mcp_servers section when missing', () => {
    const text = upsertOrcaServer('gateway:\n  port: 8080\n', 'https://h/mcp');
    expect(text).toContain('mcp_servers:');
    expect(orcaServerState(text)).toEqual({ registered: true, enabled: true });
    expect(text).toContain('port: 8080'); // prior content kept
  });
});

describe('upsertEnvVar', () => {
  it('appends a new key to an env file', () => {
    const out = upsertEnvVar('FOO=1\n', 'MCP_ORCA_API_KEY', 'tok');
    expect(out).toContain('FOO=1');
    expect(out).toContain('MCP_ORCA_API_KEY=tok');
  });
  it('replaces an existing key in place', () => {
    const out = upsertEnvVar('A=1\nMCP_ORCA_API_KEY=old\nB=2\n', 'MCP_ORCA_API_KEY', 'new');
    expect(out).toContain('MCP_ORCA_API_KEY=new');
    expect(out).not.toContain('old');
    expect(out).toContain('A=1');
    expect(out).toContain('B=2');
  });
  it('handles an empty env file', () => {
    expect(upsertEnvVar('', 'MCP_ORCA_API_KEY', 'tok')).toBe('MCP_ORCA_API_KEY=tok\n');
  });
});
