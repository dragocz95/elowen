import { describe, expect, it } from 'vitest';
import type { UserPluginConfigDetail } from '../../../lib/types';
import { userPluginConfigDescription, userPluginConfigLabel } from '../../../modules/account/userPluginConfigStrings';

const detail = (over: Partial<UserPluginConfigDetail> = {}): UserPluginConfigDetail => ({
  name: 'github',
  config: {},
  secretsSet: [],
  revision: 0,
  userConfigSchema: [],
  ...over,
});

describe('per-account plugin config strings', () => {
  it('names the entry by its declared label, not by the manifest sentence', () => {
    const record = detail({ label: 'GitHub', description: 'Account-scoped GitHub CLI device authentication for this user.' });
    expect(userPluginConfigLabel(record, 'en')).toBe('GitHub');
    expect(userPluginConfigDescription(record, 'en')).toBe('Account-scoped GitHub CLI device authentication for this user.');
  });

  // The regression this closes: a plugin whose only string was a full English sentence had that sentence
  // rendered as the rail's title, widening the rail and truncating mid-word.
  it('falls back to the plugin id rather than to the description when no label is declared', () => {
    const record = detail({ description: 'Account-scoped GitHub CLI device authentication for this user.' });
    expect(userPluginConfigLabel(record, 'en')).toBe('github');
  });

  it('prefers the plugin\'s own translation for the active locale, with no English mixed in', () => {
    const record = detail({
      label: 'Browser',
      description: 'Browser automation.',
      i18n: { cs: { userConfigLabel: 'Prohlížeč', description: 'Automatizace prohlížeče.' } },
    });
    expect(userPluginConfigLabel(record, 'cs')).toBe('Prohlížeč');
    expect(userPluginConfigDescription(record, 'cs')).toBe('Automatizace prohlížeče.');
    // A locale the plugin does not translate keeps the manifest's English — that is the fallback, and it
    // must not leak into a locale that IS translated.
    expect(userPluginConfigLabel(record, 'sk')).toBe('Browser');
  });

  it('ignores a blank translation instead of rendering an empty menu entry', () => {
    const record = detail({ label: 'Raynet CRM', i18n: { cs: { userConfigLabel: '   ' } } });
    expect(userPluginConfigLabel(record, 'cs')).toBe('Raynet CRM');
  });

  it('reports no description when the plugin ships none, so the caller can use its own caption', () => {
    expect(userPluginConfigDescription(detail(), 'cs')).toBeUndefined();
  });
});
