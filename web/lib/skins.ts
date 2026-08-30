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

import type { LocaleDict } from './i18n/types';

/** Every skin compiled into this build. A new skin needs: a folder web/skins/<name>/ with skin.css,
 *  an @import line in web/skins/index.css, and its name here — a contract test holds the three in sync.
 *
 *  This stays a plain tuple of ids because that is what the rest of the app consumes: a directory name, a
 *  `data-skin` value, a member test against `readonly string[]`. The richer per-skin metadata lives in
 *  SKIN_DEFINITIONS below, keyed by these ids. */
export const SKINS = ['studio-light', 'studio-oled'] as const;
export type SkinName = (typeof SKINS)[number];

/** Skins that are variants of ONE design rather than separate designs. `studio-light` and `studio-oled`
 *  share every structural rule and differ only in their token block, so anything that reasons about the
 *  design — shared stylesheets, docs, a future grouped picker — reasons about the family.
 *
 *  One family today, and it stays a named union rather than collapsing into the id list: the family is
 *  what a shared stylesheet is scoped to, and a second design added later needs a name to be scoped to
 *  before it has any skins. */
type SkinFamily = 'studio';

/** Which navigation/shell presentation a design mounts. This is a property of the SHELL, not of a skin:
 *  `spatial` is the layered, ambient shell the app has always rendered, `command` is the flat command-grid
 *  presentation Studio asks for. Two skins of the same family necessarily share one.
 *
 *  No design this build ships asks for `spatial` any more: both compiled skins are Studio, and every
 *  resolution now lands on one of them. It stays in the union because the profile is a property a skin
 *  DECLARES — a deployment fork adding an ambient design names it here and gets that shell back — and
 *  because the seam is what keeps the shell from recognising a design by id. It is unreachable in this
 *  build by construction, not by accident: `shellProfileFor` reads DEFAULT_SKIN's profile for everything
 *  that is not a compiled skin, so there is no input to the app that produces it. */
export type ShellProfile = 'spatial' | 'command';

/** The dictionary key holding a skin's human name. Skins are named in `common.skinNames` rather than by
 *  their id: an id is a directory and an attribute value, and `studio-oled` is not a name to show anyone. */
type SkinNameKey = keyof LocaleDict['common']['skinNames'];

export interface SkinDefinition {
  readonly id: SkinName;
  readonly family: SkinFamily;
  readonly shellProfile: ShellProfile;
  readonly nameKey: SkinNameKey;
}

/** Every compiled skin's metadata. Declared as a total Record over SkinName so the compiler — not review —
 *  rejects a skin added to SKINS with no definition, and a definition for a skin that does not exist. */
export const SKIN_DEFINITIONS: Record<SkinName, SkinDefinition> = {
  'studio-light': { id: 'studio-light', family: 'studio', shellProfile: 'command', nameKey: 'studioLight' },
  'studio-oled': { id: 'studio-oled', family: 'studio', shellProfile: 'command', nameKey: 'studioOled' },
};

/** Every skin belonging to a family, in SKINS order. Derived, never restated: a skin's family is stated
 *  once, in its definition, so membership cannot drift away from it. */
function skinsInFamily(family: SkinFamily): SkinName[] {
  return SKINS.filter((id) => SKIN_DEFINITIONS[id].family === family);
}

/** Stylesheets under web/skins/ holding structure shared by a whole family, keyed by the family that owns
 *  them. Paths are the ONLY thing declared by hand here — a file location cannot be derived from types —
 *  and a family with no shared stylesheet simply has no entry.
 *
 *  These files are the reason this declaration exists at all. A per-skin stylesheet is scoped by its own
 *  directory name, which tests/lib/skins.test.ts can check without being told anything; a shared file has
 *  no such name, so the set of ids it is allowed to target has to be stated somewhere the guard can read. */
const SHARED_STYLESHEET_PATHS = {
  studio: ['studio/shared.css', 'studio/surfaces.css', 'studio/workbench.css'],
} as const satisfies Partial<Record<SkinFamily, readonly string[]>>;

export interface SkinFamilySheets {
  readonly family: SkinFamily;
  /** Exactly the skins a shared stylesheet of this family may target — derived from SKIN_DEFINITIONS, so
   *  an id that is not a real SkinName is a compile error rather than a test failure. */
  readonly members: readonly SkinName[];
  /** Paths relative to web/skins/. */
  readonly sharedStylesheets: readonly string[];
}

/** The families that own a shared stylesheet, with the member set that stylesheet must scope itself to.
 *  Consumed by the scope and colour guards in tests/lib/. */
export const SKIN_FAMILY_SHEETS: readonly SkinFamilySheets[] = (
  Object.keys(SHARED_STYLESHEET_PATHS) as (keyof typeof SHARED_STYLESHEET_PATHS)[]
).map((family) => ({
  family,
  members: skinsInFamily(family),
  sharedStylesheets: SHARED_STYLESHEET_PATHS[family],
}));

/** THE FLOOR UNDER EVERY RESOLUTION, and the reason `resolveSkin` cannot return null.
 *
 *  Every path that used to end at "no skin" ends here instead: nothing chosen, a choice the admin has
 *  revoked, a stored name this build no longer compiles, an unset or malformed ELOWEN_SKIN. The document
 *  therefore ALWAYS carries `data-skin`; the unattributed pre-skins design no longer exists. */
export const DEFAULT_SKIN: SkinName = 'studio-light';

export const isSkinName = (value: string | null | undefined): value is SkinName =>
  !!value && (SKINS as readonly string[]).includes(value);

/** The display name of a compiled skin. A missing choice shows the design actually used as the floor. */
export function skinDisplayName(t: LocaleDict, skin: SkinName | null): string {
  return t.common.skinNames[SKIN_DEFINITIONS[skin ?? DEFAULT_SKIN].nameKey];
}

/** Which shell presentation a design asks the app to mount. Unknown or missing data uses DEFAULT_SKIN. */
export function shellProfileFor(skin: SkinName | null | undefined): ShellProfile {
  return SKIN_DEFINITIONS[skin ?? DEFAULT_SKIN].shellProfile;
}

/** The compiled designs an account may actually pick, in operator order and without duplicates. */
export function allowedSkinChoices(configured: readonly string[] | null | undefined): SkinName[] {
  if (!configured) return [];
  const out: SkinName[] = [];
  for (const name of configured) {
    if (!isSkinName(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** Resolve any stored input to one of the two compiled designs. Unknown legacy values naturally fall back. */
export function resolveSkin(
  chosen: string | null | undefined,
  allowed: readonly SkinName[],
  fallback: SkinName | null,
): SkinName {
  if (isSkinName(chosen) && allowed.includes(chosen)) return chosen;
  return fallback ?? DEFAULT_SKIN;
}

/** The choice corresponding to what is currently on screen, or null when that design is not selectable. */
export function currentSkinChoice(
  chosen: string | null | undefined,
  allowed: readonly SkinName[],
  fallback: SkinName | null,
): SkinName | null {
  if (isSkinName(chosen) && allowed.includes(chosen)) return chosen;
  const implied = fallback ?? DEFAULT_SKIN;
  return allowed.includes(implied) ? implied : null;
}

/** Advance through the allowed compiled designs, wrapping at the end. */
export function nextSkinChoice(current: SkinName | null, allowed: readonly SkinName[]): SkinName | null {
  if (allowed.length === 0) return null;
  const at = current ? allowed.indexOf(current) : -1;
  return allowed[(at + 1) % allowed.length];
}
