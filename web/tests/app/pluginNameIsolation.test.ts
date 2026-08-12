import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Architectural invariant of the plugin-extraction work: the core Settings app must not special-case
 *  plugins BY NAME — a plugin's own settings UI belongs in its web-src bundle (settings deck), served
 *  only while the plugin is enabled. This greps the settings modules for name dispatches so a new
 *  hardcoded `detail.name === 'x'` branch fails CI instead of quietly re-growing the old pattern.
 *
 *  Documented exceptions, each with its removal path:
 *  - 'msteams' in PluginConfigEditor (TeamsAppPackageSection) — not yet extracted.
 *  - PluginLivePreview's per-platform config previews — decorative previews rendered inside the core
 *    schema editor; extraction candidate for a later batch.
 *  - AgentsPluginGate/useAgentsPlugin — the agents presence hook, scheduled for a later batch. */
const SETTINGS_DIR = join(process.cwd(), 'modules', 'settings');
const EXCEPTIONS: Record<string, string[]> = {
  'PluginConfigEditor.tsx': ["'msteams'"],
  'PluginLivePreview.tsx': ["'discord'", "'whatsapp'", "'cronjob'", "'terminal'"],
};
// The plugin names whose editors were extracted (plus platform names generally) — none of these may
// be dispatched on in the settings modules again.
const NAME_DISPATCH = /detail\.name === '([a-z0-9-]+)'|name === '([a-z0-9-]+)'/g;

describe('core settings modules do not special-case plugins by name', () => {
  it('greps every settings module for name dispatches outside the documented exceptions', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SETTINGS_DIR).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))) {
      const src = readFileSync(join(SETTINGS_DIR, file), 'utf-8');
      const allowed = EXCEPTIONS[file] ?? [];
      for (const m of src.matchAll(NAME_DISPATCH)) {
        const name = `'${m[1] ?? m[2]}'`;
        if (!allowed.includes(name)) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
