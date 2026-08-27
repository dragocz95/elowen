// Skins are CODE, not data: each one is a stylesheet in web/skins/<name>/skin.css, compiled into the
// build and scoped under `:root[data-skin='<name>']`, so ONE build carries every design and the document
// picks which one applies by carrying the attribute. This is deliberately the opposite trade-off from the
// runtime theme system (lib/brandServer.ts): a skin may restyle ANYTHING — layout, panels, navigation —
// because it ships and is tested together with the markup it targets, while a theme is validated data
// limited to brand tokens precisely because it lives outside the repo.
//
// Because every skin is already in the browser, switching one is only an attribute write — no stylesheet
// to fetch, nothing to rebuild, no reload. That is what makes a per-account choice cheap enough to be
// worth having at all, rather than a second deployment.
//
// This module is pure and safe to import from a client component. Reading the operator's env default is
// deliberately NOT here for exactly that reason — see lib/skinEnv.ts.

/** Every skin compiled into this build. A new skin needs: a folder web/skins/<name>/ with skin.css,
 *  an @import line in web/skins/index.css, and its name here — a contract test holds the three in sync. */
export const SKINS = ['midnight'] as const;
export type SkinName = (typeof SKINS)[number];

/** The built-in design, which is not a skin at all but the ABSENCE of one: no `data-skin` attribute, so
 *  no skin's rules match and the markup renders exactly as it did before skins existed. It still needs a
 *  name, because "go back to the plain design" has to be selectable like any other option — otherwise
 *  allowing a single skin would be a one-way door. Reserved: a contract test fails if a compiled skin ever
 *  takes this name, since the two meanings would then be indistinguishable in a stored choice. */
export const BUILTIN_SKIN = 'default';
export type SkinChoice = SkinName | typeof BUILTIN_SKIN;

/** Every choice that can be offered, built-in design first. One stable order so the switcher and the
 *  admin list cannot disagree about what exists. */
export const SKIN_CHOICES: readonly SkinChoice[] = [BUILTIN_SKIN, ...SKINS];

export const isSkinChoice = (value: string | null | undefined): value is SkinChoice =>
  !!value && (SKIN_CHOICES as readonly string[]).includes(value);

/** The choices an account may actually pick, from the names the operator allowed in instance config.
 *  Intersected with what THIS build compiled: the daemon stores names without knowing which skins exist,
 *  because that registry is a build artifact of `web/`, so an allowed name with no stylesheet behind it is
 *  dropped here rather than offered as an option that would visibly do nothing. The operator's order is
 *  kept — it is the order the switcher cycles through. */
export function allowedSkinChoices(configured: readonly string[] | null | undefined): SkinChoice[] {
  if (!configured) return [];
  const out: SkinChoice[] = [];
  for (const name of configured) {
    if (!isSkinChoice(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** What the document's `data-skin` attribute must be: a compiled skin name, or null for the built-in
 *  design. `chosen` is the account's stored choice and is honoured only while it is still allowed, which
 *  is what makes the admin list a real control rather than a suggestion — revoking a skin moves everyone
 *  holding it back on their next document, without having to reach into anybody's stored value.
 *
 *  `fallback` is the operator's ELOWEN_SKIN. It applies to anyone who has not chosen, and to anyone whose
 *  choice is no longer on offer, so the DEPLOYMENT's design stays the floor rather than the built-in one:
 *  an instance that ships a brand skin must not fall back to looking like stock Elowen. */
export function resolveSkin(
  chosen: string | null | undefined,
  allowed: readonly SkinChoice[],
  fallback: SkinName | null,
): SkinName | null {
  if (chosen && isSkinChoice(chosen) && allowed.includes(chosen)) {
    return chosen === BUILTIN_SKIN ? null : chosen;
  }
  return fallback;
}

/** The choice corresponding to what is currently on screen, so the switcher starts where the eye is.
 *  Null when the visible design is the operator's default AND that default is not itself on offer —
 *  cycling then starts at the first allowed choice instead of pretending the current look was picked. */
export function currentSkinChoice(
  chosen: string | null | undefined,
  allowed: readonly SkinChoice[],
  fallback: SkinName | null,
): SkinChoice | null {
  if (chosen && isSkinChoice(chosen) && allowed.includes(chosen)) return chosen;
  const implied: SkinChoice = fallback ?? BUILTIN_SKIN;
  return allowed.includes(implied) ? implied : null;
}

/** The next choice in the allowed list — the entire interaction of the switcher, which is one button
 *  rather than a menu. Wraps around, and starts at the first entry when nothing is selected yet. */
export function nextSkinChoice(current: SkinChoice | null, allowed: readonly SkinChoice[]): SkinChoice | null {
  if (allowed.length === 0) return null;
  const at = current ? allowed.indexOf(current) : -1;
  return allowed[(at + 1) % allowed.length];
}
