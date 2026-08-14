import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';

/**
 * A grant withholds a plugin's TOOLS, its HTTP routes and its web UI — and nothing else. Everything else
 * a plugin can contribute is installed globally: prompt fragments and slash commands are merged into the
 * system prompt of EVERY session, hooks run on everyone's tool calls, and MCP tools are advertised to
 * every authenticated caller (`src/mcp/server.ts`). So a plugin that opts into per-user grants must not
 * contribute any of those, or the grant would be a gate with a hole beside it.
 *
 * The loader warns about this at startup; a warning nobody reads is not an invariant, which is what this
 * test is for. If a bundled plugin ever needs one of these surfaces, the gate has to learn to filter it —
 * not this test to learn an exception.
 */
const pluginsDir = join(process.cwd(), 'plugins');
const log = { info: () => {}, warn: () => {}, error: () => {} };

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });
const freshDataRoot = (): string => { const p = mkdtempSync(join(tmpdir(), 'elowen-grantable-')); dirs.push(p); return p; };

/** Every bundled plugin whose manifest opted into per-user grants. Read from disk, so a new one is
 *  covered the moment it ships rather than when somebody remembers to list it here. */
function grantablePlugins(): string[] {
  return readdirSync(pluginsDir)
    .filter((name) => {
      const manifest = join(pluginsDir, name, 'elowen-plugin.json');
      if (!existsSync(manifest)) return false;
      return (JSON.parse(readFileSync(manifest, 'utf8')) as { userGrantable?: boolean }).userGrantable === true;
    })
    .sort();
}

describe('a user-grantable plugin only contributes what the grant can withhold', () => {
  it('finds the grantable plugins from their manifests', () => {
    // Guards the test itself: if this ever reads empty, the loop below would pass by doing nothing.
    expect(grantablePlugins()).toEqual(['cronjob']);
  });

  for (const name of grantablePlugins()) {
    it(`${name} registers no prompt fragment, command, hook or MCP tool`, async () => {
      // Loaded alone, so every contribution in the registry is unambiguously this plugin's.
      const reg = await loadPlugins({ dirs: [pluginsDir], enabled: [name], dataRoot: freshDataRoot(), logger: log });

      expect(reg.tools.length).toBeGreaterThan(0); // it did load and register something
      expect(reg.promptFragments).toEqual([]);
      expect([...reg.commands.keys()]).toEqual([]);
      expect(reg.hooks).toEqual([]);
      expect(reg.mcpTools).toEqual([]);
    });
  }
});
