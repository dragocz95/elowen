import './globals.css';
import '@fontsource-variable/inter';
// The wordmark's face. Declared globally because @font-face is inert until a rule asks for the family —
// only a design that names it (`--studio-brand-font`) makes a browser fetch the file — and self-hosted
// because a brand lockup that arrives one network round trip after the menu it belongs to is worse than
// no wordmark at all.
import '@fontsource-variable/space-grotesk';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import { Shell } from '../components/shell/Shell';
import { fetchThemePayload, buildThemeStyle, themeIcon } from '../lib/brandServer';
import { fetchPluginUiListing, fetchMe, hasSessionCookie, readLocale, readSkinChoice, fetchAllowedSkins } from '../lib/serverPrefetch';
import { activeSkin } from '../lib/skinEnv';
import { allowedSkinChoices, resolveSkin, type SkinName } from '../lib/skins';

// Every route renders per request — the brand payload is fetched live, so a theme switch must land on
// the next reload. This CANNOT be left to the `no-store` fetch inside fetchThemePayload: its failure
// backoff returns early WITHOUT touching fetch, and a render that hits that path uses no dynamic API at
// all, so Next classifies the route as static and bakes the built-in brand into the full route cache
// (exactly what happened when `next build` ran while the daemon was down).
export const dynamic = 'force-dynamic';

// PWA name and icons follow the instance brand (white-label theme), resolved per request so a theme
// switch lands on the next reload without a rebuild. The browser title is deliberately absent here:
// components/shell/DocumentTitle is its sole owner, because Next metadata and a client-rendered <title>
// otherwise remain as competing head nodes and the metadata node wins `document.title` by document order.
//
// Icons otherwise come from Next file conventions: app/icon.png → <link rel="icon"> and
// app/apple-icon.png → <link rel="apple-touch-icon">. Declaring `metadata.icons` REPLACES that
// convention wholesale, so it is declared only when the theme actually carries artwork — a themeless
// install keeps the auto-generated links and renders exactly as before. When the theme does carry
// icons, the same replacement is the point: leaving the convention in place would emit the bundled
// Elowen favicon alongside the instance's own and let the browser pick either one.
export async function generateMetadata() {
  const theme = await fetchThemePayload();
  const appName = theme.text.en?.appName ?? theme.brand.productName;
  // The apple-touch icon is composited onto a home screen at ~180px, so it prefers the large artwork
  // and falls back to the tab mark only when a theme ships nothing else.
  // The tab takes the dedicated favicon slot, or the static mascot when a theme ships no separate
  // mark. It must NOT be the other way round: `icon` is also the agent avatar, so a theme that wants a
  // distinct tab mark supplies favicon.png and leaves the mascot where the rest of the UI expects it.
  const favicon = themeIcon(theme, 'favicon') ?? themeIcon(theme, 'icon');
  const touchIcon = themeIcon(theme, 'icon192') ?? favicon;
  return {
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, title: appName, statusBarStyle: 'black' as const },
    ...(favicon || touchIcon
      ? {
        icons: {
          ...(favicon ? { icon: [{ url: favicon }] } : {}),
          ...(touchIcon ? { apple: [{ url: touchIcon }] } : {}),
        },
      }
      : {}),
  };
}

/** What the document paints with before any stylesheet has been parsed, and what the browser's own
 *  chrome uses forever after. `background` is the anti-FOUC fill on <html>/<body>: it MUST equal the
 *  design's own `--color-background`, because the moment the stylesheet lands the element repaints with the
 *  token and any disagreement is visible as a flash. `colorScheme` drives UA-rendered widgets and the
 *  default canvas; `themeColor` is the same colour again, reported to the address bar and the task
 *  switcher, so the two can never drift apart. */
type DocumentPaint = { background: string; colorScheme: 'dark' | 'light' };

/** Per-skin first frame. These are the only colour literals the app is allowed to hold outside a token,
 *  and they exist because the first frame happens before `--color-background` is defined: nothing can be read
 *  from the cascade yet, so the value has to be duplicated here and kept in step with the skin by hand.
 *  `Record<SkinName, …>` makes that duplication mechanical: adding a skin without deciding what it paints
 *  is a type error rather than a black flash, and `tests/app/layoutDynamic.test.ts` compares each entry
 *  against the `--color-background` its stylesheet declares. The natural home for this is the skin registry in
 *  `lib/skins.ts`; it stays here while that module is imported by CLIENT components, which have no use
 *  for a server-only first-frame value.
 *
 *  There is no entry for "no skin" any more, and no `DEFAULT_PAINT` beside this map. `resolveSkin` always
 *  returns a compiled skin — a stored name this build no longer carries, a revoked choice and an unset
 *  ELOWEN_SKIN all land on DEFAULT_SKIN — so every document has a design, and the black Ember first frame
 *  that used to stand in for its absence would have been a third look nobody could select. */
const SKIN_PAINT: Record<SkinName, DocumentPaint> = {
  'studio-light': { background: '#ffffff', colorScheme: 'light' },
  'studio-oled': { background: '#03080a', colorScheme: 'dark' },
};

const documentPaint = (skin: SkinName): DocumentPaint => SKIN_PAINT[skin];

type SkinResolution = {
  choice: SkinName | null;
  allowed: SkinName[];
  fallback: SkinName | null;
  /** What `data-skin` must be. Always a compiled skin — see DEFAULT_SKIN in lib/skins.ts. */
  skin: SkinName;
};

/** The one resolution of "which design is this document wearing", shared by the viewport and the markup
 *  so the browser chrome cannot disagree with the page. Both reads underneath are request-scoped through
 *  React `cache`, so calling this from both places costs one cookie read and one config fetch. */
async function resolveDocumentSkin(): Promise<SkinResolution> {
  const [choice, allowedSkins] = await Promise.all([readSkinChoice(), fetchAllowedSkins()]);
  const allowed = allowedSkinChoices(allowedSkins);
  const fallback = activeSkin();
  return { choice, allowed, fallback, skin: resolveSkin(choice, allowed, fallback) };
}

// Browser chrome follows the ACTIVE design's canvas, not a fixed black one: a light skin that reported
// `#000000` here would keep a dark address bar and a dark task-switcher card permanently, long after the
// first frame is gone. It has to be `generateViewport` rather than a static `viewport` object for exactly
// that reason — the skin is per account and per request, which a module-level constant cannot express.
// `viewportFit: cover` lays the app edge-to-edge so `env(safe-area-inset-*)` resolves (notch / home
// indicator, incl. the installed PWA); `interactiveWidget: resizes-content` shrinks the layout viewport
// (and therefore `100dvh`) when the soft keyboard opens, so a sticky bottom composer stays above it.
export async function generateViewport() {
  const paint = documentPaint((await resolveDocumentSkin()).skin);
  return {
    colorScheme: paint.colorScheme,
    themeColor: paint.background,
    viewportFit: 'cover' as const,
    interactiveWidget: 'resizes-content' as const,
  };
}

// Apply the per-device effects preference before first paint. This prevents an opted-out device from
// briefly playing entrance or ambient motion while React hydrates. Theme is fixed in the markup.
const NO_FLASH_EFFECTS = `(function(){try{var m=localStorage.getItem('elowen:effects');m=m==='full'||m==='reduced'||m==='off'?m:'auto';var r=m==='auto'?(window.matchMedia('(prefers-reduced-motion: reduce)').matches?'reduced':'full'):m;document.documentElement.setAttribute('data-effects-mode',m);document.documentElement.setAttribute('data-effects',r);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-rendered theme overrides: the values are in the markup before first paint (no FOUC), and the
  // login screen — rendered before any token exists — already carries the instance brand.
  const theme = await fetchThemePayload();
  const themeStyle = buildThemeStyle(theme);
  // Server-prefetch what the navigation rail is made of, so it arrives COMPLETE in the HTML instead of
  // growing after the client's own fetches resolve (the layout shift this removes). Two halves: the
  // plugin worlds, and the identity — the system group renders admin destinations only once `is_admin`
  // is known. Issued together, because awaiting them in sequence would put both round-trips into TTFB.
  // The locale comes from the cookie the client mirrors its choice into, so the document is rendered in
  // the user's own language from the start and the listing seed matches the client's first-paint query
  // key. Null — logged out, 401/403, daemon down — renders exactly as before and the client queries
  // fill it in.
  const locale = await readLocale();
  // Every skin ships in every build, scoped under `:root[data-skin='…']`, and the document ALWAYS carries
  // the attribute: the app has two designs and no third, unattributed one. WHICH of the two applies is
  // resolved on the server, from the account's cookie against the instance allow-list, with the operator's
  // ELOWEN_SKIN above DEFAULT_SKIN as the floor — so the document arrives already wearing the right design
  // instead of visibly changing colour once hydration reads localStorage.
  const [pluginUi, me, sessionPresent, skinState] = await Promise.all([
    fetchPluginUiListing(locale), fetchMe(), hasSessionCookie(), resolveDocumentSkin(),
  ]);
  const { choice: skinChoice, allowed, fallback: skinDefault, skin } = skinState;
  // The first frame, before globals.css has been parsed. Both elements carry it: <html> is what the
  // browser paints the canvas from, and <body> keeps the fill while the sheet is still loading.
  const paint = documentPaint(skin);
  return (
    <html
      lang={locale}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      data-skin={skin}
      data-effects-mode="auto"
      data-effects="full"
      style={{ backgroundColor: paint.background }}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_EFFECTS }} />
        {themeStyle ? <style id="theme-overrides" dangerouslySetInnerHTML={{ __html: themeStyle }} /> : null}
      </head>
      <body style={{ backgroundColor: paint.background }}><Shell theme={theme} pluginUiSeed={pluginUi ? { locale, listing: pluginUi } : null} meSeed={me} sessionPresent={sessionPresent} initialLocale={locale} skinSeed={{ choice: skinChoice, allowed, fallback: skinDefault }}>{children}</Shell></body>
    </html>
  );
}
