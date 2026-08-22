import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { THEME_ASSET_PATH_RE } from '../../lib/brandShared';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf-8');

// public/ is served verbatim and never bundled, so the service worker cannot import any of this —
// it carries its own copy of the rules. These are source-level pins because that copy is the only
// thing a phone actually runs, and nothing else would notice it drifting.
describe('push notification branding', () => {
  it('takes the notification artwork from the instance theme, not the bundled logo', () => {
    const sw = source('public', 'sw.js');
    // Both slots come from the resolved brand. A literal bundled path here is the bug this pins:
    // every themed install pushed the Elowen mark to its users' phones.
    expect(sw).toContain('badge: brand.icon,');
    expect(sw).toContain('icon: brand.icon,');
    expect(sw).not.toMatch(/(badge|icon):\s*'\/elowen-logo\.png'/);
    // …while the bundled asset stays as the fallback, so a failed lookup still renders something.
    expect(sw).toContain("const FALLBACK_ICON = '/elowen-logo.png';");
  });

  it('reads the brand from the unauthenticated public theme route', () => {
    const sw = source('public', 'sw.js');
    expect(sw).toContain("const THEME_URL = '/api/public/theme';");
    // Network-first: a theme switch has to reach the next notification rather than wait for a cache
    // to expire. The cached copy is the fallback, not the source of truth.
    expect(sw).toMatch(/await fetch\(THEME_URL/);
    expect(sw).toMatch(/cache\.match\(THEME_URL\)/);
  });

  it('validates a theme asset path with the same grammar the app uses', () => {
    const sw = source('public', 'sw.js');
    const declared = /const ASSET_PATH_RE = \/(.*)\/;/.exec(sw)?.[1];
    // Character-identical, not merely equivalent: the service worker's copy exists only because it
    // cannot import the real one, and a payload steering this at an arbitrary daemon route is
    // exactly what the grammar is there to stop.
    expect(declared).toBe(THEME_ASSET_PATH_RE.source);
  });
});

// Declaring metadata.icons REPLACES Next's file convention (app/icon.png, app/apple-icon.png). That
// is wanted when a theme ships its own artwork and wrong when it does not, so the declaration has to
// stay conditional — an unconditional one would drop the favicon from every themeless install.
describe('favicon follows the theme', () => {
  it('declares icons only when the theme carries them', () => {
    const layout = source('app', 'layout.tsx');
    // The dedicated slot first, the static mascot only as the fallback — never the reverse, since
    // `icon` is also the agent avatar and a tab-sized mark there looks like a bug.
    expect(layout).toContain("themeIcon(theme, 'favicon') ?? themeIcon(theme, 'icon')");
    expect(layout).toContain('...(favicon || touchIcon');
    expect(layout).toMatch(/\.\.\.\(favicon \? \{ icon: \[\{ url: favicon \}\] \} : \{\}\)/);
    expect(layout).toMatch(/\.\.\.\(touchIcon \? \{ apple: \[\{ url: touchIcon \}\] \} : \{\}\)/);
  });
});
