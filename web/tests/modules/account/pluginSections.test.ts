import { describe, expect, it } from 'vitest';
import { parsePluginAccountSectionId, pluginAccountSectionId } from '../../../modules/account/pluginSections';

describe('plugin account section ids', () => {
  it('round-trips plugin and section names without delimiter collisions', () => {
    const id = pluginAccountSectionId('github-enterprise', 'connection:personal');
    expect(parsePluginAccountSectionId(id)).toEqual({ plugin: 'github-enterprise', section: 'connection:personal' });
  });

  it('rejects malformed and unrelated values', () => {
    expect(parsePluginAccountSectionId('profile')).toBeNull();
    expect(parsePluginAccountSectionId('plugin-account:github')).toBeNull();
    expect(parsePluginAccountSectionId('plugin-account:%zz:connection')).toBeNull();
  });
});
