import type { PluginRegistry } from './registry.js';

/** Named contribution (tools/skills/platforms/hooks) with its owning plugin. */
interface NamedContribution { name: string; plugin: string }
/** Unnamed contribution (prompt fragments / turn-context providers) — only the owning plugin is known. */
interface AnonContribution { plugin: string }

/** The ACTUAL loaded contributions of the merged plugin registry, each tagged with the plugin that
 *  registered it. Distinct from the manifests' declarative `provides` (that's what a plugin CLAIMS on
 *  disk); this is what ended up live after load. Powers the admin runtime-introspection endpoint. */
export interface PluginContributionReport {
  tools: NamedContribution[];
  skills: NamedContribution[];
  platforms: NamedContribution[];
  promptFragments: AnonContribution[];
  turnContexts: AnonContribution[];
  hooks: NamedContribution[];
}

/** Fallback owner label when an attribution slot is somehow missing (never expected once a plugin
 *  registers through `contextFor`, which always records the owner alongside the contribution). */
const UNKNOWN = 'unknown';

/** Project a merged PluginRegistry into the runtime contribution report. Pure — no I/O, no Hono — so
 *  it is unit-testable against a hand-built registry. Tools read ownership from the `toolOwner` Map;
 *  the flat lists read it from their index-aligned owner arrays. */
export function buildContributionReport(registry: PluginRegistry): PluginContributionReport {
  return {
    tools: registry.tools.map((t) => ({ name: t.name, plugin: registry.toolOwner.get(t.name) ?? UNKNOWN })),
    skills: registry.skills.map((s, i) => ({ name: s.name, plugin: registry.skillOwners[i] ?? UNKNOWN })),
    platforms: registry.platforms.map((p, i) => ({ name: p.name, plugin: registry.platformOwners[i] ?? UNKNOWN })),
    promptFragments: registry.promptFragments.map((_, i) => ({ plugin: registry.promptFragmentOwners[i] ?? UNKNOWN })),
    turnContexts: registry.turnContexts.map((_, i) => ({ plugin: registry.turnContextOwners[i] ?? UNKNOWN })),
    hooks: registry.hooks.map((h, i) => ({ name: h.name, plugin: registry.hookOwners[i] ?? UNKNOWN })),
  };
}

/** The empty report returned when no plugin registry is wired (keeps the endpoint from 500-ing). */
export function emptyContributionReport(): PluginContributionReport {
  return { tools: [], skills: [], platforms: [], promptFragments: [], turnContexts: [], hooks: [] };
}

/** Project the merged registry down to just the contributions OWNED BY `name`. Same shape as
 *  buildContributionReport, filtered per-contribution: tools via the `toolOwner` Map, the flat lists
 *  via their index-aligned owner arrays. Pure — powers the per-plugin Tools + Hooks detail sections. */
export function pluginContributions(registry: PluginRegistry, name: string): PluginContributionReport {
  return {
    tools: registry.tools
      .filter((t) => registry.toolOwner.get(t.name) === name)
      .map((t) => ({ name: t.name, plugin: name })),
    skills: registry.skills
      .filter((_, i) => registry.skillOwners[i] === name)
      .map((s) => ({ name: s.name, plugin: name })),
    platforms: registry.platforms
      .filter((_, i) => registry.platformOwners[i] === name)
      .map((p) => ({ name: p.name, plugin: name })),
    promptFragments: registry.promptFragments
      .filter((_, i) => registry.promptFragmentOwners[i] === name)
      .map(() => ({ plugin: name })),
    turnContexts: registry.turnContexts
      .filter((_, i) => registry.turnContextOwners[i] === name)
      .map(() => ({ plugin: name })),
    hooks: registry.hooks
      .filter((_, i) => registry.hookOwners[i] === name)
      .map((h) => ({ name: h.name, plugin: name })),
  };
}
