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

/** The name a stored choice or an instance allow-list may still carry for "no design of my own". It was
 *  once the ABSENCE of a skin — no `data-skin` attribute, and the pre-skins Ember markup underneath — and
 *  that is no longer a design this app ships: the app has exactly two looks, and an unattributed document
 *  was a third. The name is kept because it is DATA this build cannot reach into (a stored preference, a
 *  configured allow-list, an admin's saved list), and rejecting it would strand those accounts on an
 *  option that silently does nothing; it now resolves to DEFAULT_SKIN like every other route into the
 *  resolution. Reserved: a contract test fails if a compiled skin ever takes this name, since the two
 *  meanings would then be indistinguishable in a stored choice. */
export const BUILTIN_SKIN = 'default';
export type SkinChoice = SkinName | typeof BUILTIN_SKIN;

/** THE FLOOR UNDER EVERY RESOLUTION, and the reason `resolveSkin` cannot return null.
 *
 *  Every path that used to end at "no skin" ends here instead: nothing chosen, a choice the admin has
 *  revoked, a stored name this build no longer compiles, an unset or malformed ELOWEN_SKIN. The document
 *  therefore ALWAYS carries `data-skin`, which is what makes "this app has two looks" true rather than
 *  aspirational — the unattributed state was a third design that nothing selected on purpose and that
 *  every fallback landed on by accident.
 *
 *  It has to be a real compiled skin rather than a palette copied into the base tokens, because a design
 *  is not only its colours: `skins/studio/*.css` carry the whole Studio structure and are scoped to the
 *  two `[data-skin]` values, so a document without the attribute would wear studio-light's palette on the
 *  old ambient shell. The attribute is the design. */
export const DEFAULT_SKIN: SkinName = 'studio-light';

/** What to SHOW for a choice, in the reader's language. Every call site goes through here so a skin's
 *  name is decided in one place — the definition — instead of a switch per switcher. Null and the
 *  compatibility choice are the same thing to a reader: whatever this deployment defaults to. */
export function skinDisplayName(t: LocaleDict, choice: SkinChoice | null): string {
  if (!choice || choice === BUILTIN_SKIN) return t.common.skinBuiltIn;
  return t.common.skinNames[SKIN_DEFINITIONS[choice].nameKey];
}

/** Which shell presentation a design asks the app to mount. Anything that is not a compiled skin — the
 *  compatibility name, null, undefined — reads the DEFAULT_SKIN's profile, so the shell cannot mount a
 *  presentation no design asks for.
 *
 *  This is the ONE place the mapping lives: the shell reads a profile, never a skin id, so recognising a
 *  design by name cannot start spreading through the component tree. */
export function shellProfileFor(skin: SkinChoice | null | undefined): ShellProfile {
  if (!skin || skin === BUILTIN_SKIN) return SKIN_DEFINITIONS[DEFAULT_SKIN].shellProfile;
  return SKIN_DEFINITIONS[skin].shellProfile;
}

const isSkinName = (value: string | null | undefined): value is SkinName =>
  !!value && (SKINS as readonly string[]).includes(value);

export const isSkinChoice = (value: string | null | undefined): value is SkinChoice =>
  value === BUILTIN_SKIN || isSkinName(value);

/** The designs an account may actually pick, from the names the operator allowed in instance config.
 *  Unknown names and the legacy `default` alias are dropped: `default` still resolves safely when found in
 *  stored data, but exposing it beside Studio Light would present the same look twice. */
export function allowedSkinChoices(configured: readonly string[] | null | undefined): SkinName[] {
  if (!configured) return [];
  const out: SkinName[] = [];
  for (const name of configured) {
    if (!isSkinName(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** What the document's `data-skin` attribute must be — ALWAYS a compiled skin name, never nothing.
 *
 *  `chosen` is the account's stored choice and is honoured only while it is still allowed, which is what
 *  makes the admin list a real control rather than a suggestion: revoking a skin moves everyone holding
 *  it back on their next document, without having to reach into anybody's stored value. The
 *  compatibility name resolves to DEFAULT_SKIN directly rather than to `fallback`, which preserves the
 *  rule it has always carried — an explicit "no design of my own" outranks the operator's default.
 *
 *  `fallback` is the operator's ELOWEN_SKIN. It applies to anyone who has not chosen, to anyone whose
 *  choice is no longer on offer, and to anyone holding a name this build no longer compiles, so the
 *  DEPLOYMENT's design stays the floor above DEFAULT_SKIN: an instance that ships a brand skin must not
 *  fall back to looking like stock Elowen. */
export function resolveSkin(
  chosen: string | null | undefined,
  allowed: readonly SkinChoice[],
  fallback: SkinName | null,
): SkinName {
  if (chosen && isSkinChoice(chosen) && allowed.includes(chosen)) {
    return chosen === BUILTIN_SKIN ? DEFAULT_SKIN : chosen;
  }
  return fallback ?? DEFAULT_SKIN;
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
  const implied: SkinChoice = fallback ?? DEFAULT_SKIN;
  return allowed.includes(implied) ? implied : null;
}

/** The next choice in the allowed list — the entire interaction of the switcher, which is one button
 *  rather than a menu. Wraps around, and starts at the first entry when nothing is selected yet. */
export function nextSkinChoice(current: SkinChoice | null, allowed: readonly SkinChoice[]): SkinChoice | null {
  if (allowed.length === 0) return null;
  const at = current ? allowed.indexOf(current) : -1;
  return allowed[(at + 1) % allowed.length];
}
