import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SKINS } from '../../lib/skins';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The root layout must OPT INTO dynamic rendering explicitly. Relying on the `no-store` theme fetch is
// not enough: fetchThemePayload's failure backoff returns early without touching fetch, and a render
// hitting that path uses no dynamic API — Next then classifies the route as static and bakes the
// built-in brand into the full route cache (a `next build` with the daemon down shipped an app whose
// every page said Elowen forever, whatever theme was active). Source-level pin on purpose: the
// classification happens at build time, where no unit test can observe it.
describe('root layout rendering mode', () => {
  it("exports dynamic = 'force-dynamic'", () => {
    const src = readFileSync(join(root, 'app', 'layout.tsx'), 'utf-8');
    expect(src).toContain("export const dynamic = 'force-dynamic';");
  });
});

// ---------------------------------------------------------------------------------------------------
// First paint
// ---------------------------------------------------------------------------------------------------

/** The one value the layout is allowed to be told from outside: the operator's ELOWEN_SKIN, which
 *  `resolveSkin` returns verbatim as the fallback. Driving the resolution from here exercises the real
 *  cookie/allow-list path in the layout while letting a test name a skin. */
const env = vi.hoisted(() => ({ skin: null as string | null }));

vi.mock('../../app/globals.css', () => ({ default: '' }));
vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-geist-sans' } }));
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-geist-mono' } }));
vi.mock('../../components/shell/Shell', () => ({ Shell: () => null }));
vi.mock('../../lib/brandServer', () => ({
  fetchThemePayload: async () => ({ text: {}, brand: { productName: 'Elowen' } }),
  buildThemeStyle: () => '',
  themeIcon: () => null,
}));
vi.mock('../../lib/serverPrefetch', () => ({
  readLocale: async () => 'en',
  readSkinChoice: async () => null,
  fetchAllowedSkins: async () => null,
  fetchPluginUiListing: async () => null,
  fetchMe: async () => null,
  hasSessionCookie: async () => false,
}));
vi.mock('../../lib/skinEnv', () => ({ activeSkin: () => env.skin }));

const layout = async () => await import('../../app/layout');

type Node = { type?: unknown; props: Record<string, unknown> };

/** The <html> and <body> elements the layout returns, with the inline anti-FOUC fill each carries. */
async function documentElements(): Promise<{ html: Node; body: Node }> {
  const { default: RootLayout } = await layout();
  const html = await RootLayout({ children: null }) as unknown as Node;
  expect(html.type).toBe('html');
  const kids = html.props.children;
  const body = (Array.isArray(kids) ? kids : [kids]).find((k) => (k as Node | null)?.type === 'body');
  return { html, body: body as Node };
}

const background = (node: Node): string => (node.props.style as { backgroundColor: string }).backgroundColor;

/** WCAG relative luminance, the same computation `tests/lib/designTokens.test.ts` runs on the palette —
 *  enough to tell a light canvas from a dark one without hardcoding the shade twice. */
function luminance(hex: string): number {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** `--color-background` of a design, i.e. what the stylesheet repaints the canvas with the instant it lands. */
function canvasToken(skin: string | null): string {
  const file = skin ? join(root, 'skins', skin, 'skin.css') : join(root, 'app', 'styles', 'tokens.css');
  const match = readFileSync(file, 'utf-8').match(/--color-background:\s*(#[0-9a-f]{3,8})/i);
  expect(match, `${skin ?? 'default'} declares no --color-background`).toBeTruthy();
  return match![1]!.toLowerCase();
}

// The first frame is painted from an inline literal because it happens before any stylesheet exists, so
// it is the one colour in the app that a skin CANNOT reach. Hardcoding it dark meant a light skin painted
// black for a frame, flipped to near-white, and then kept a dark address bar and a dark task-switcher
// card forever — none of which any stylesheet test can see.
describe('first paint follows the resolved skin', () => {
  beforeEach(() => { env.skin = null; });

  it('paints the built-in design with the canvas its own tokens declare', async () => {
    const { html, body } = await documentElements();
    expect(html.props['data-skin']).toBeUndefined();
    expect(background(html).toLowerCase()).toBe(canvasToken(null));
    expect(background(body)).toBe(background(html));

    const { generateViewport } = await layout();
    expect(await generateViewport()).toMatchObject({ colorScheme: 'dark', themeColor: background(html) });
  });

  it.each([...SKINS])('paints skin "%s" with the canvas its stylesheet declares', async (skin) => {
    env.skin = skin;
    const { html, body } = await documentElements();
    expect(html.props['data-skin']).toBe(skin);
    expect(background(html).toLowerCase()).toBe(canvasToken(skin));
    expect(background(body)).toBe(background(html));
  });

  it('reports a light skin as light to the browser chrome, never as black', async () => {
    env.skin = 'studio-light';
    const { html, body } = await documentElements();
    const viewport = await (await layout()).generateViewport();

    expect(viewport.colorScheme).toBe('light');
    expect(viewport.themeColor).toBe(background(html));
    expect(background(body)).toBe(background(html));
    expect(luminance(background(html)), 'a light skin must not paint a dark first frame')
      .toBeGreaterThan(0.5);
  });

  it('keeps colour-scheme and canvas in agreement for every declared paint', async () => {
    // A dark canvas reported as `light` (or the reverse) makes the UA render form controls and the
    // scrollbar against the wrong background — the failure mode a single-design app could never have.
    for (const skin of [null, ...SKINS]) {
      env.skin = skin;
      const { html } = await documentElements();
      const viewport = await (await layout()).generateViewport();
      const light = luminance(background(html)) > 0.5;
      expect(viewport.colorScheme, `${skin ?? 'default'} reports the wrong colour scheme`)
        .toBe(light ? 'light' : 'dark');
      expect(viewport.themeColor, `${skin ?? 'default'} reports a theme colour it does not paint`)
        .toBe(background(html));
    }
  });
});
