'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConfig } from './queries';
import {
  DEFAULT_SKIN,
  allowedSkinChoices,
  currentSkinChoice,
  isSkinChoice,
  nextSkinChoice,
  resolveSkin,
  type SkinChoice,
  type SkinName,
} from './skins';

const STORAGE_KEY = 'elowen-skin';

/** Mirrors the choice where the SERVER can see it, exactly as the locale does: localStorage stays the
 *  client's source of truth, and the cookie exists purely so the FIRST PAINT is already right. Without it
 *  the document would arrive in the operator's default design and be repainted a moment later — which for
 *  a skin means the whole interface visibly changing colour after it appeared. */
function writeSkinCookie(choice: SkinChoice): void {
  // One year, path-wide, Lax: it carries a UI preference, never a credential, so it does not need to be
  // httpOnly (the client has to write it) and must not be cross-site.
  document.cookie = `${STORAGE_KEY}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

function readSkinCookie(): SkinChoice | null {
  const match = document.cookie.match(/(?:^|;\s*)elowen-skin=([^;]*)/);
  const value = match ? decodeURIComponent(match[1]) : null;
  return isSkinChoice(value) ? value : null;
}

interface SkinContextValue {
  /** The account's current choice, or null when the visible design is the operator's default and that
   *  default is not itself one of the offered choices. */
  choice: SkinChoice | null;
  /** The skin the document is actually WEARING — exactly what `data-skin` says, and never nothing: every
   *  resolution ends at a compiled skin (DEFAULT_SKIN is the floor). It is not the same thing as
   *  `choice`: an operator who sets ELOWEN_SKIN without offering it in the allow-list gives everyone that
   *  design with nothing chosen, so `choice` is null while the document wears a skin. Anything deciding
   *  what to RENDER for the active design has to read this one — reading `choice` would mount one
   *  design's shell inside another design's stylesheet. */
  skin: SkinName;
  /** What may be picked. Empty means the instance has not enabled switching at all. */
  allowed: SkinChoice[];
  /** Advance to the next allowed choice — the switcher's whole interaction. */
  cycle: () => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);

/** THE ONE WRITER of what the document wears, and the whole mechanism: every skin's CSS is already in the
 *  page, scoped under its own `[data-skin]`, so the attribute alone decides which rules match. No fetch,
 *  no reload, no flash.
 *
 *  It takes the RESOLVED skin rather than the account's choice, because the resolution is what `data-skin`
 *  states: revoking the active skin from the allow-list, or moving the operator's ELOWEN_SKIN, changes the
 *  visible design while the page is open, and both land on another COMPILED skin — DEFAULT_SKIN when
 *  nothing else decides. The attribute is therefore never removed; there is no unattributed document to
 *  fall back to. Every path that can change the visible design goes through this function via the single
 *  effect below, so the attribute cannot disagree with the `skin` the context reports and the shell
 *  renders from.
 *
 *  The attribute is not quite the whole story, because it is not the only thing painting the canvas. The
 *  server writes an inline `background-color` onto <html> and <body> (app/layout.tsx) so the document has
 *  the right fill BEFORE the stylesheet is parsed — and an inline style outranks the `var(--color-background)`
 *  rule in base.css that would otherwise follow the skin. Left in place it freezes the canvas at whatever
 *  design the document was SERVED as: switching to studio-oled repainted every surface near-black while
 *  <html> stayed white underneath, which shows in the overscroll fill and in the browser's own chrome.
 *
 *  So the switch hands the canvas back to the cascade. Deleting the inline value is the whole fix, and it
 *  needs no second copy of any palette on the client: by the time anyone can press the switcher the
 *  stylesheet has long since landed, so `--color-background` is already the authority the anti-FOUC value was
 *  standing in for. The same reasoning covers the theme colour, which is read back from the resolved token
 *  rather than restated — the address bar and the task switcher then follow the design like everything
 *  else, instead of reporting the one the document happened to arrive in. */
function applySkin(skin: SkinName): void {
  const root = document.documentElement;
  root.setAttribute('data-skin', skin);
  root.style.removeProperty('background-color');
  document.body?.style.removeProperty('background-color');
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = getComputedStyle(root).backgroundColor;
}

/** `initialChoice` and `fallback` are what the SERVER rendered this document with. Starting state must
 *  match them exactly or hydration would mismatch — and starting from anything else is what would make the
 *  interface repaint in another design a moment after it appeared. */
export function SkinProvider({
  children,
  initialChoice = null,
  allowedSkins,
  fallback = null,
}: {
  children: ReactNode;
  initialChoice?: SkinChoice | null;
  allowedSkins?: readonly string[];
  fallback?: SkinName | null;
}) {
  // The seed is what the SERVER could see, and a logged-out document sees nothing: the prefetch has no
  // session cookie to forward, so it returns null and the seed is empty. Without the live query, someone
  // who logs in without reloading would never be offered the switcher at all — the page they land on was
  // rendered before they had an identity. The query is not an extra request: the shell already reads the
  // same config for its toast durations.
  const config = useConfig();
  const allowed = useMemo(
    () => allowedSkinChoices(config.data?.allowedSkins ?? allowedSkins),
    [config.data?.allowedSkins, allowedSkins],
  );
  const [choice, setChoice] = useState<SkinChoice | null>(initialChoice);

  useEffect(() => {
    // localStorage remains the client's source of truth, so a session that predates the cookie — or one
    // whose cookie was cleared — still gets its stored choice back, and writing the cookie means the NEXT
    // document is already correct on the server. A stored choice the admin has since revoked is dropped
    // here rather than applied, which is the same rule the server used, so the two cannot disagree.
    //
    // Reconciled against the CURRENT choice, not against the one the server seeded: the allow-list is live
    // and can narrow and widen again while the page is open, and comparing to the seed would make the
    // first revocation permanent — re-allowing the skin would leave the dropped choice at null, because
    // the recomputed value happens to equal the seed again. The functional update is what lets React bail
    // out when nothing changed, which is the only thing the seed comparison was buying.
    const stored = localStorage.getItem(STORAGE_KEY);
    const resolved = currentSkinChoice(stored ?? readSkinCookie(), allowed, fallback);
    setChoice((previous) => (previous === resolved ? previous : resolved));
    if (resolved) {
      if (stored !== resolved) localStorage.setItem(STORAGE_KEY, resolved);
      if (readSkinCookie() !== resolved) writeSkinCookie(resolved);
    }
  }, [allowed, fallback]);

  const cycle = useCallback(() => {
    const next = nextSkinChoice(choice, allowed);
    if (!next) return;
    setChoice(next);
    localStorage.setItem(STORAGE_KEY, next);
    writeSkinCookie(next);
  }, [allowed, choice]);

  // The same resolution the SERVER ran to decide the attribute (app/layout.tsx), so the two cannot
  // disagree about which design is on screen.
  const skin = useMemo(() => resolveSkin(choice, allowed, fallback), [choice, allowed, fallback]);
  // The document follows that resolution and nothing else. Every way the visible design can change — first
  // mount, the switcher, an admin revoking the active skin, the operator's default moving — changes THIS
  // value and therefore lands here, so there is one place deciding what `<html>` wears and no path that
  // can leave a stale attribute behind.
  useEffect(() => { applySkin(skin); }, [skin]);
  const value = useMemo(() => ({ choice, skin, allowed, cycle }), [choice, skin, allowed, cycle]);
  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

/** Tolerates a missing provider (bare component tests, isolated mounts) by reporting nothing to switch —
 *  the switcher then renders nothing, which is also what an instance with switching disabled does. The
 *  skin it reports is DEFAULT_SKIN rather than "none", for the same reason the provider never removes the
 *  attribute: a component mounted outside the provider still has to render for a real design, and the one
 *  it would have got from a real document with nothing chosen is the default. */
export function useSkin(): SkinContextValue {
  return useContext(SkinContext) ?? { choice: null, skin: DEFAULT_SKIN, allowed: [], cycle: () => {} };
}
