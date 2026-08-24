import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ungrantedPluginTools } from '../../src/plugins/toolGrants.js';
import { toolAuthorityForUser } from '../../src/brain/brainDeps.js';
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

/** `toolAuthorityForUser` only ever reads these two, and a Pick is what it declares. */
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
    const denyOf = (row: ReturnType<typeof user> | undefined, id = 5) =>
      [...(toolAuthorityForUser(deps(row, registry()), id)?.deny ?? [])];
    expect(denyOf(u)).toEqual(['Bash', 'GatedRead', 'GatedWrite']);
    expect(denyOf(user({ disabled_tools: ['Bash'], granted_plugins: ['gated'] }))).toEqual(['Bash']);
  });

  it('withholds a gated tool from an id it cannot resolve, instead of handing it out', () => {
    // A deleted or unknown account must fail closed: "no row" is not "no restrictions".
    const policy = toolAuthorityForUser(deps(undefined, registry()), 999);
    expect([...(policy?.deny ?? [])]).toEqual(['GatedRead', 'GatedWrite']);
    // …and it receives no GRANT either. An absent row must not read as "unrestricted": that is the
    // difference between a deleted account inheriting everything and inheriting nothing.
    expect(policy?.allow).toBeDefined();
    expect([...(policy?.allow ?? [])]).toEqual([]);
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

// A PLATFORM session (Discord, Teams, WhatsApp, Telegram, cron) has no single account behind it: the
// sender changes from turn to turn, so `skillOwnerForSession` hands composition no owner at all. With
// grants applied at compose time that meant a grant-gated tool -- the shell, after it became grantable
// -- was absent for EVERYONE on those surfaces, including the admin who owned the cron job, and nothing
// reported why. Grants move to the per-turn gate there, which is the sender-accurate place anyway.
describe('platform sessions decide grants per turn, not per session', () => {
  const withTools = (personalOwner: number | null = null): PluginRegistry => {
    const r = registry();
    for (const name of ['GatedRead', 'OpenTool']) {
      r.tools.push({ name } as unknown as PluginRegistry['tools'][number]);
      r.toolOwnerUsers.push(personalOwner);
    }
    return r;
  };
  const ungranted = { is_admin: false, granted_plugins: [] };

  it('composes a grant-gated tool for a session that has no owner to check grants against', () => {
    const r = withTools();
    // How a platform session actually calls it: no owner id, no user row.
    expect(r.toolsFor(null, null, { grantsEnforcedPerTurn: true }).map((t) => t.name))
      .toEqual(['GatedRead', 'OpenTool']);
    // Without the flag the same call composes nothing gated -- the behaviour that emptied the shell out
    // of every platform surface.
    expect(r.toolsFor(null, null).map((t) => t.name)).toEqual(['OpenTool']);
  });

  it('still refuses it at execute time for a sender who lacks the grant', () => {
    const r = withTools();
    // Composed...
    expect(r.toolsFor(null, null, { grantsEnforcedPerTurn: true }).map((t) => t.name)).toContain('GatedRead');
    // ...and simultaneously on that sender's deny-list, which is what gateToolAccess enforces per turn.
    // Being in BOTH is the point here: composition stops deciding, the sender's own policy decides.
    // Both of the gated plugin's tools, since the deny-list is built from the registry's ownership map
    // rather than from what this particular session happened to compose.
    expect(ungrantedPluginTools(ungranted, r)).toEqual(['GatedRead', 'GatedWrite']);
    expect(ungrantedPluginTools({ is_admin: false, granted_plugins: ['gated'] }, r)).toEqual([]);
  });

  it('does not hand a shared room one person\'s personal tools', () => {
    // The ownership filter is untouched by the flag: a personal contribution belongs to its owner's
    // sessions, and a room shared with other people is not one of them.
    const r = withTools(7);
    expect(r.toolsFor(null, null, { grantsEnforcedPerTurn: true })).toEqual([]);
    expect(r.toolsFor(7, { is_admin: false, granted_plugins: [] }, { grantsEnforcedPerTurn: true })
      .map((t) => t.name)).toEqual(['GatedRead', 'OpenTool']);
  });

  it('leaves owner chat composing against grants as before', () => {
    const r = withTools();
    expect(r.toolsFor(5, ungranted).map((t) => t.name)).toEqual(['OpenTool']);
  });
});
