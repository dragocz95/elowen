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
export const SKINS = ['midnight', 'studio-light', 'studio-oled'] as const;
export type SkinName = (typeof SKINS)[number];

/** Skins that are variants of ONE design rather than separate designs. `studio-light` and `studio-oled`
 *  share every structural rule and differ only in their token block, so anything that reasons about the
 *  design — shared stylesheets, docs, a future grouped picker — reasons about the family. */
type SkinFamily = 'midnight' | 'studio';

/** Which navigation/shell presentation a design mounts. This is a property of the SHELL, not of a skin:
 *  `spatial` is the layered, ambient shell the app has always rendered, `command` is the flat command-grid
 *  presentation Studio asks for. Two skins of the same family necessarily share one. */
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
  midnight: { id: 'midnight', family: 'midnight', shellProfile: 'spatial', nameKey: 'midnight' },
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

/** What to SHOW for a choice, in the reader's language. Every call site goes through here so a skin's
 *  name is decided in one place — the definition — instead of a switch per switcher. Null and the
 *  built-in choice are the same thing to a reader: the plain design. */
export function skinDisplayName(t: LocaleDict, choice: SkinChoice | null): string {
  if (!choice || choice === BUILTIN_SKIN) return t.common.skinBuiltIn;
  return t.common.skinNames[SKIN_DEFINITIONS[choice].nameKey];
}

/** Which shell presentation a design asks the app to mount. The built-in design is not a skin and has no
 *  definition, so it — and "no skin at all" — resolve to the shell the app has always rendered.
 *
 *  This is the ONE place the mapping lives: the shell reads a profile, never a skin id, so recognising a
 *  design by name cannot start spreading through the component tree. */
export function shellProfileFor(skin: SkinChoice | null | undefined): ShellProfile {
  if (!skin || skin === BUILTIN_SKIN) return 'spatial';
  return SKIN_DEFINITIONS[skin].shellProfile;
}

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
