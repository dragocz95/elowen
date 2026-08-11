import { describe, it, expect } from 'vitest';
import { Puzzle, Sparkles } from 'lucide-react';
import { isPluginSettingsSectionId, pluginSettingsSections } from '../../../modules/settings/pluginSections';
import type { PluginUiListing } from '../../../lib/types';

const listing = (settings: PluginUiListing['settings'], name = 'demo'): PluginUiListing => (
  { name, url: `/plugins/${name}/web/abc.js`, apiVersion: 1, nav: [], settings }
);

describe('pluginSettingsSections', () => {
  it('maps every declared settings entry to a namespaced deck section', () => {
    const sections = pluginSettingsSections([
      listing([{ id: 'general', label: 'Demo', icon: 'Sparkles' }, { id: 'extra', label: 'Extra' }]),
      listing([], 'quiet'),
    ]);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ id: 'plugin:demo:general', plugin: 'demo', settingId: 'general', label: 'Demo' });
    expect(sections[0]!.icon).toBe(Sparkles);
    // No icon (or an unknown name) falls back to the puzzle piece, same as plugin nav.
    expect(sections[1]).toMatchObject({ id: 'plugin:demo:extra', settingId: 'extra' });
    expect(sections[1]!.icon).toBe(Puzzle);
  });

  it('recognizes its own section ids by shape and never a core category', () => {
    expect(isPluginSettingsSectionId('plugin:demo:general')).toBe(true);
    expect(isPluginSettingsSectionId('system')).toBe(false);
    expect(isPluginSettingsSectionId('plugins')).toBe(false);
  });
});
