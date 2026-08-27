import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ICON_NAMES, pluginLucideIcon } from '../../lib/pluginIcons';

const PLUGINS_DIR = join(__dirname, '../../../plugins');

/** Every `icon` a manifest declares, wherever it sits — nav entry, settings section, project or account
 *  panel. The shape differs per surface, so this walks rather than reaching for known keys. */
function declaredIcons(manifest: unknown, plugin: string, out: { plugin: string; icon: string }[] = []) {
  if (!manifest || typeof manifest !== 'object') return out;
  for (const [key, value] of Object.entries(manifest as Record<string, unknown>)) {
    if (key === 'icon' && typeof value === 'string') out.push({ plugin, icon: value });
    else if (typeof value === 'object') declaredIcons(value, plugin, out);
  }
  return out;
}

function bundledManifestIcons() {
  const found: { plugin: string; icon: string }[] = [];
  for (const dir of readdirSync(PLUGINS_DIR)) {
    const manifestPath = join(PLUGINS_DIR, dir, 'elowen-plugin.json');
    if (!existsSync(manifestPath)) continue;
    declaredIcons(JSON.parse(readFileSync(manifestPath, 'utf8')), dir, found);
  }
  return found;
}

describe('plugin manifest icons', () => {
  it('resolves every icon a bundled manifest names', () => {
    // The lookup falls back to a puzzle piece for an unknown name, and it does so SILENTLY: the field is
    // just a string, so nothing type-checks it and nothing logs it. Three bundled plugins shipped a
    // puzzle piece that way until someone happened to look at the tab strip. An unknown name is either a
    // typo or an icon that belongs in the curated map, and both are decisions to make here, not in
    // production.
    const unknown = bundledManifestIcons().filter((entry) => !PLUGIN_ICON_NAMES.includes(entry.icon));
    expect(unknown, `add these to ICONS in web/lib/pluginIcons.ts, or correct the manifest: ${
      unknown.map((entry) => `${entry.plugin} → ${entry.icon}`).join(', ')}`).toEqual([]);
  });

  it('still falls back to the puzzle piece rather than crashing on an unknown name', () => {
    // Registry plugins are installed at runtime and this repo cannot see their manifests, so the
    // fallback has to stay — the test above narrows the blast radius, it does not remove the need.
    expect(pluginLucideIcon('NoSuchIconExists')).toBe(pluginLucideIcon(undefined));
  });
});
