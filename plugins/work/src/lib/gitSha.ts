/** Does this string look like a plain git object id — 4 to 40 hex digits (`/^[0-9a-f]{4,40}$/i`)?
 *  Hex-only by design: these values are interpolated into `git` command lines, and the plain-hex shape
 *  is what guarantees one can never be parsed as a flag/option (`--all`, `-c`) or a pathspec.
 *  Mirrors src/shared/gitSha.ts — a plugin may not import daemon code at runtime, and the label writer
 *  that guards `base:<sha>` lives here now. */
export function isGitSha(value: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(value);
}
