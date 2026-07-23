import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins, discoverPlugins } from '../../src/plugins/loader.js';
import { builtinToolMetas, BUILTIN_TOOL_PLAN_SAFE } from '../../src/brain/tools/index.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginDir = join(repoRoot, 'plugins');

/** Tool names are a wire contract (`--json` events, MCP, per-user permission rules), so their shape is
 *  a domain rule, not a style preference: TitleCase, no separators. `mcp__*` is the ONE exception — those
 *  names are minted at runtime from a remote server's own tool list (plugins/mcp), never authored here. */
const TITLE_CASE = /^[A-Z][A-Za-z0-9]*$/;

/** Discord/Telegram/Teams gate their tools behind configured credentials, so without them they register
 *  nothing and this guard would silently inspect a short list. Fake credentials register the full toolset
 *  without connecting — the adapter is only recorded (`registerPlatform` is a stub), never started. */
const CONFIG = {
  discord: { botToken: 'tok', rolePolicies: [] },
  telegram: { botToken: 'tok' },
  msteams: { appId: 'app', appPassword: 'pw', tenantId: 'tenant' },
};

async function loadEveryBundledPlugin() {
  const names = discoverPlugins([pluginDir]).map((p) => p.manifest.name);
  return loadPlugins({ dirs: [pluginDir], enabled: names, logger: log, config: CONFIG });
}

describe('tool naming convention', () => {
  it('every bundled plugin tool is TitleCase', async () => {
    const reg = await loadEveryBundledPlugin();
    // Guards the guard: a config/loader regression that registers nothing must fail loudly rather than
    // vacuously pass an empty list.
    expect(reg.tools.length).toBeGreaterThan(70);
    expect(reg.tools.map((t) => t.name).filter((n) => !TITLE_CASE.test(n))).toEqual([]);
  });

  it('every built-in brain tool is TitleCase', () => {
    const metas = builtinToolMetas();
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.map((m) => m.name).filter((n) => !TITLE_CASE.test(n))).toEqual([]);
  });
});

describe('plan-safe declarations', () => {
  // A typo here fails closed (the tool just vanishes from plan mode) so nothing would ever surface it.
  it('every tool a manifest declares plan-safe is a tool that plugin actually registers', async () => {
    const reg = await loadEveryBundledPlugin();
    const registered = new Set(reg.tools.map((t) => t.name));
    expect([...reg.toolPlanSafe].filter((n) => !registered.has(n))).toEqual([]);
  });

  it('every built-in declared plan-safe is a real built-in, and no mutating one slipped in', () => {
    const names = new Set(builtinToolMetas().map((m) => m.name));
    expect(BUILTIN_TOOL_PLAN_SAFE.filter((n) => !names.has(n))).toEqual([]);
    // Spot-check the boundary this list exists to hold: plan mode must never compose these.
    for (const mutating of ['ElowenCreateTask', 'ElowenUpdateTask', 'ElowenPlan', 'MemoryAdd', 'MemoryDelete']) {
      expect(BUILTIN_TOOL_PLAN_SAFE).not.toContain(mutating);
    }
  });
});

describe('plugin manifest / code parity', () => {
  // registry.ts refuses a tool absent from `provides.tools` with a WARN and a silent drop, so a manifest
  // that drifts from its .mjs does not fail the build — the tool just vanishes. This is the only check
  // that catches it.
  it('each plugin registers exactly the tools its manifest declares', async () => {
    const reg = await loadEveryBundledPlugin();
    const registered = new Map<string, string[]>();
    for (const t of reg.tools) {
      const owner = reg.toolOwner.get(t.name);
      if (owner) (registered.get(owner) ?? registered.set(owner, []).get(owner)!).push(t.name);
    }
    for (const p of discoverPlugins([pluginDir])) {
      const declared = p.manifest.provides?.tools;
      if (!declared) continue; // an undeclared surface is unconstrained by design (skills)
      // A `prefix*` entry declares a DYNAMIC surface (the mcp bridge names its tools per configured
      // server at runtime) — nothing registers under it in this serverless test env, so patterns are
      // excluded from the exact-name comparison and pattern-covered registrations are dropped too.
      const patterns = declared.filter((d) => d.endsWith('*')).map((d) => d.slice(0, -1));
      const exact = declared.filter((d) => !d.endsWith('*'));
      const actual = (registered.get(p.manifest.name) ?? []).filter((n) => !patterns.some((pre) => n.startsWith(pre)));
      expect([...exact].sort(), `plugin '${p.manifest.name}'`).toEqual([...actual].sort());
    }
  });
});
