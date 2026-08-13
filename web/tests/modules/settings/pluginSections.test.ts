import { describe, it, expect } from 'vitest';
import { isPluginSettingsSectionId, parsePluginSettingsSectionId } from '../../../modules/settings/pluginSections';

describe('plugin settings section ids', () => {
  it('recognizes its own section ids by shape and never a core category', () => {
    expect(isPluginSettingsSectionId('plugin:demo:general')).toBe(true);
    expect(isPluginSettingsSectionId('system')).toBe(false);
    expect(isPluginSettingsSectionId('plugins')).toBe(false);
  });

  it('splits an id back into the plugin and the section it names', () => {
    expect(parsePluginSettingsSectionId('plugin:demo:general')).toEqual({ plugin: 'demo', settingId: 'general' });
  });

  it('refuses a malformed id instead of returning half of one', () => {
    // These ids arrive from localStorage and from old links, i.e. from user input: a half-parsed id
    // would forward the reader to `/p//settings/x` — a URL that resolves to nothing and explains less.
    expect(parsePluginSettingsSectionId('plugin:demo')).toBeNull();
    expect(parsePluginSettingsSectionId('plugin::general')).toBeNull();
    expect(parsePluginSettingsSectionId('plugin:demo:')).toBeNull();
    expect(parsePluginSettingsSectionId('system')).toBeNull();
  });
});
