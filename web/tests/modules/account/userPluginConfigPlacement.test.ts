import { describe, expect, it } from 'vitest';
import type { UserPluginConfigDetail } from '../../../lib/types';
import { userPluginConfigSectionEntries } from '../../../modules/account/sections';

const detail = (over: Partial<UserPluginConfigDetail> = {}): UserPluginConfigDetail => ({
  name: 'github',
  config: {},
  secretsSet: [],
  revision: 0,
  userConfigSchema: [],
  ...over,
});

/** One setting, one editor. A plugin that presents its per-account values on its OWN page says so in its
 *  manifest, and the Account rail must then not offer a second, schema-driven form for the same values —
 *  two editors over one store is how a person ends up changing something in one place and seeing the old
 *  answer in the other. */
describe('per-account plugin config placement', () => {
  it('keeps the rail entry for a plugin that declares no placement', () => {
    const entries = userPluginConfigSectionEntries([detail()], 'en', 'fallback');
    expect(entries.map((e) => e.detail.name)).toEqual(['github']);
  });

  it('keeps it for an explicit account placement', () => {
    const entries = userPluginConfigSectionEntries([detail({ placement: 'account' })], 'en', 'fallback');
    expect(entries.map((e) => e.detail.name)).toEqual(['github']);
  });

  it('drops it for a plugin whose own page owns the form', () => {
    const entries = userPluginConfigSectionEntries(
      [detail({ name: 'subagent', placement: 'pluginPage' }), detail()],
      'en',
      'fallback',
    );
    expect(entries.map((e) => e.detail.name)).toEqual(['github']);
  });
});
