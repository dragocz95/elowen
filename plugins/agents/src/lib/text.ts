/** Small text primitives shared across the daemon. They live here because each one was written more than
 *  once, and a second copy of a pattern is how the two drift apart. */

/** Neutralize regex metacharacters so a runtime string matches literally. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Fold every run of whitespace — newlines included — into single spaces, and trim. The one-line form of
 *  text that has to sit in a label, a title or a log line. Length capping is the caller's business. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Does `haystack` contain `needle` as a WHOLE token?
 *
 *  Unicode-aware on purpose. The obvious `\W` spelling is ASCII-only unless the `u` flag is set, which
 *  makes every accented letter count as a token boundary — so with Czech text a category named "práce"
 *  matched inside "mépráce", and "auto" inside "néauto". Letters and digits of ANY script are what a
 *  boundary must exclude. */
export function containsWholeToken(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  const boundary = '[^\\p{L}\\p{N}_]';
  return new RegExp(`(?:^|${boundary})${escapeRegExp(needle)}(?:${boundary}|$)`, 'u').test(haystack);
}

/** Strip C0/C1 control characters. This is a security boundary, not cosmetics: brand/display names
 *  cross into terminals (CLI notices, tmux titles) where an ESC/OSC sequence is a title or clipboard
 *  injection, and no legitimate display string contains control characters. Kept as ONE shared helper
 *  because the daemon (theme manifests, config names) and the CLI (payloads from a possibly foreign
 *  daemon) must enforce the exact same class — a drifted copy would fail only in production. */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** Remove a literal `prefix` from the start of `value`, if present; otherwise return `value` unchanged.
 *  The anchored `^` + escapeRegExp spelling keeps the prefix literal — e.g. session ids `elowen-…` —
 *  and a prefix appearing mid-string is deliberately left alone. */
export function stripPrefix(value: string, prefix: string): string {
  return value.replace(new RegExp(`^${escapeRegExp(prefix)}`), '');
}
