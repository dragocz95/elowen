import { describe, it, expect } from 'vitest';
import { CORE_MCP_TOOLS } from '../../src/mcp/tools.js';
import type { PluginMcpTool } from '../../src/plugins/api.js';

/** Golden pin of the daemon's OWN /mcp tool surface: the generic escape hatch in src/mcp/tools.ts.
 *  Spawned agents carry these tool names, descriptions and argument shapes in their prompts and habits,
 *  so ANY drift — a rename, a reworded description, a changed/removed argument, a reorder — must fail
 *  here and be a deliberate decision, never a side effect of a refactor. Each line is
 *  `name :: args (?, in declaration order) :: description`.
 *
 *  The task and mission tools are pinned the same way beside the plugins that own them, in the plugin
 *  registry (tests/mcp-toolParity.test.ts there) — including the manifest deny-by-default check, which
 *  reads those plugins' own manifests. */
const shape = (t: PluginMcpTool): string => {
  const args = Object.entries(t.inputSchema).map(([k, v]) => (v.isOptional() ? `${k}?` : k)).join(',');
  return `${t.name} :: ${args || '-'} :: ${t.description}`;
};

describe('daemon /mcp tool surface parity', () => {
  it('core tools match the pinned ordered surface', () => {
    expect(CORE_MCP_TOOLS.map(shape)).toEqual([
      'elowen_request :: method,path,body? :: Call any Elowen REST endpoint (full control). Generic escape hatch — every endpoint works without a dedicated tool.',
    ]);
  });
});
