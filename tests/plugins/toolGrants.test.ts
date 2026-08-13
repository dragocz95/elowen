import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ungrantedPluginTools } from '../../src/plugins/toolGrants.js';
import { deniedToolsForUser } from '../../src/brain/brainDeps.js';
import type { BrainDeps } from '../../src/brain/brainDeps.js';
import type { User } from '../../src/store/userStore.js';

/** A registry holding two tools per plugin, `gated` opted into per-user grants and `open` not. */
function registry(): PluginRegistry {
  const r = new PluginRegistry();
  r.toolOwner.set('GatedRead', 'gated');
  r.toolOwner.set('GatedWrite', 'gated');
  r.toolOwner.set('OpenTool', 'open');
  r.userGrantable.add('gated');
  return r;
}

const user = (over: Partial<User> = {}): User => ({
  id: 5, username: 'amy', is_admin: false, granted_plugins: [], disabled_tools: [], ...over,
} as unknown as User);

/** `deniedToolsForUser` only ever reads these two, and a Pick is what it declares. */
const deps = (u: User | undefined, reg: PluginRegistry | undefined): Pick<BrainDeps, 'users' | 'plugins'> => ({
  users: { get: () => u } as unknown as BrainDeps['users'],
  plugins: { peek: () => reg } as unknown as BrainDeps['plugins'],
});

describe('per-user plugin grants on brain tools', () => {
  it('withholds a grant-gated plugin\'s tools and nothing else', () => {
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: [] }, registry()))
      .toEqual(['GatedRead', 'GatedWrite']);
    // The grant is what lifts it — and it lifts only that plugin's tools.
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: ['gated'] }, registry())).toEqual([]);
    // An admin needs no grant, and a plugin that never opted in is never gated for anyone.
    expect(ungrantedPluginTools({ is_admin: true, granted_plugins: [] }, registry())).toEqual([]);
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: [] }, registry()).includes('OpenTool')).toBe(false);
  });

  it('behaves exactly as before grants existed when no plugin opted in', () => {
    const r = new PluginRegistry();
    r.toolOwner.set('OpenTool', 'open');
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: [] }, r)).toEqual([]);
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: [] }, undefined)).toEqual([]);
  });

  it('adds the ungranted tools to the account\'s own deny-list rather than replacing it', () => {
    const u = user({ disabled_tools: ['Bash'] });
    expect(deniedToolsForUser(deps(u, registry()), 5)).toEqual(['Bash', 'GatedRead', 'GatedWrite']);
    expect(deniedToolsForUser(deps(user({ disabled_tools: ['Bash'], granted_plugins: ['gated'] }), registry()), 5))
      .toEqual(['Bash']);
  });

  it('withholds a gated tool from an id it cannot resolve, instead of handing it out', () => {
    // A deleted or unknown account must fail closed: "no row" is not "no restrictions".
    expect(deniedToolsForUser(deps(undefined, registry()), 999)).toEqual(['GatedRead', 'GatedWrite']);
  });
});
