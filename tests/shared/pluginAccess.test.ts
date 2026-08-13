import { describe, it, expect } from 'vitest';
import { allowedPluginsForUser, grantablePluginNames, isPluginAllowedForUser } from '../../src/shared/pluginAccess.js';

const user = (over: Partial<{ is_admin: boolean; granted_plugins: string[] }> = {}) =>
  ({ is_admin: false, granted_plugins: [] as string[], ...over });

describe('per-user plugin access', () => {
  it('leaves a plugin that did not opt in reachable by everyone', () => {
    const plain = { name: 'files' };
    expect(isPluginAllowedForUser(user(), plain)).toBe(true);
    expect(isPluginAllowedForUser(user({ granted_plugins: ['other'] }), plain)).toBe(true);
    expect(isPluginAllowedForUser(null, plain)).toBe(true);
  });

  it('denies a grant-gated plugin by default and allows it once granted', () => {
    const gated = { name: 'cronjob', userGrantable: true };
    expect(isPluginAllowedForUser(user(), gated)).toBe(false);
    expect(isPluginAllowedForUser(user({ granted_plugins: ['cronjob'] }), gated)).toBe(true);
    // A grant for a DIFFERENT plugin must not carry over.
    expect(isPluginAllowedForUser(user({ granted_plugins: ['skills'] }), gated)).toBe(false);
  });

  it('always passes admins and open mode', () => {
    const gated = { name: 'cronjob', userGrantable: true };
    expect(isPluginAllowedForUser(user({ is_admin: true }), gated)).toBe(true);
    expect(isPluginAllowedForUser(null, gated)).toBe(true);
    expect(isPluginAllowedForUser(undefined, gated)).toBe(true);
  });

  it('does NOT read an empty grant list as "unrestricted" the way an empty exec list does', () => {
    // The whole point of the separate predicate: allowed_execs semantics inverted here would hand every
    // grant-gated plugin to every user on upgrade, since every migrated row starts empty.
    expect(isPluginAllowedForUser(user({ granted_plugins: [] }), { name: 'cronjob', userGrantable: true })).toBe(false);
  });

  it('filters a listing and enumerates what an admin can hand out', () => {
    const plugins = [{ name: 'files' }, { name: 'cronjob', userGrantable: true }, { name: 'skills', userGrantable: true }];
    expect(allowedPluginsForUser(user({ granted_plugins: ['skills'] }), plugins).map((p) => p.name)).toEqual(['files', 'skills']);
    expect(allowedPluginsForUser(user({ is_admin: true }), plugins).map((p) => p.name)).toEqual(['files', 'cronjob', 'skills']);
    expect(grantablePluginNames(plugins)).toEqual(['cronjob', 'skills']);
  });
});
