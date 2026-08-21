import { describe, expect, it } from 'vitest';
import { parseEnvironment, serverDraft, serverPayload } from '../../../plugins/mcp/web-src/McpServersPage';
import type { McpServer } from '../../../plugins/mcp/web-src/runtime';

const server: McpServer = {
  name: 'github',
  scope: 'personal',
  transport: 'stdio',
  enabled: true,
  status: 'connected',
  toolCount: 1,
  tools: [{ name: 'search', title: 'Search' }],
  lastError: null,
  reconnecting: false,
  command: 'npx',
  args: ['-y', '@example/mcp'],
  env: { TOKEN: 'secret', REGION: 'eu' },
};

describe('MCP settings form mapping', () => {
  it('round-trips a stdio server without losing command arguments or environment values', () => {
    expect(serverPayload(serverDraft(server))).toEqual({
      scope: 'personal',
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      env: { TOKEN: 'secret', REGION: 'eu' },
      enabled: true,
    });
  });

  it('keeps everything after the first equals sign in an environment value', () => {
    expect(parseEnvironment('TOKEN=a=b=c\nEMPTY=\nFLAG')).toEqual({ TOKEN: 'a=b=c', EMPTY: '', FLAG: '' });
  });

  it('does not send stale stdio credentials after switching to HTTP', () => {
    const draft = { ...serverDraft(server), transport: 'http' as const, url: 'https://mcp.example.test/' };
    expect(serverPayload(draft)).toEqual({
      scope: 'personal', name: 'github', transport: 'http', url: 'https://mcp.example.test/', enabled: true,
    });
  });
});
