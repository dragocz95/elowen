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

  // A grant is enforced TWICE by design: `toolsFor` keeps the tool out of the session, and the deny-list
  // refuses it at execute time for any set composed another way (a delegated child, a channel turn). That
  // is defense in depth over ONE fact — both ask `isPluginAllowedForUser` — but two enforcement points can
  // still be edited apart, and then a tool would be composed in while the deny-list called it forbidden,
  // or worse, composed in with nothing denying it. Pin the agreement rather than the implementations.
  describe('the two enforcement points agree', () => {
    const withTools = (): PluginRegistry => {
      const r = registry();
      for (const name of ['GatedRead', 'GatedWrite', 'OpenTool']) {
        r.tools.push({ name } as unknown as PluginRegistry['tools'][number]);
        r.toolOwnerUsers.push(null); // instance-wide, so only the GRANT decides
      }
      return r;
    };

    it('composes exactly the tools the deny-list does not withhold', () => {
      for (const u of [
        { is_admin: false, granted_plugins: [] },
        { is_admin: false, granted_plugins: ['gated'] },
        { is_admin: true, granted_plugins: [] },
      ]) {
        const r = withTools();
        const composed = r.toolsFor(5, u).map((t) => t.name);
        const denied = ungrantedPluginTools(u, r);
        // Nothing may be both composed and denied for the same reason...
        expect(composed.filter((n) => denied.includes(n)), JSON.stringify(u)).toEqual([]);
        // ...and nothing grant-gated may slip through both.
        expect([...composed, ...denied].sort(), JSON.stringify(u))
          .toEqual(['GatedRead', 'GatedWrite', 'OpenTool']);
      }
    });
  });
});
