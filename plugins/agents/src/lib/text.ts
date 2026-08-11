/** Small text primitives for the agents plugin — the core-copied set trimmed to what the subsystem uses. */

/** Neutralize regex metacharacters so a runtime string matches literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove a literal `prefix` from the start of `value`, if present; otherwise return `value` unchanged.
 *  The anchored `^` + escapeRegExp spelling keeps the prefix literal — e.g. session ids `elowen-…` —
 *  and a prefix appearing mid-string is deliberately left alone. */
export function stripPrefix(value: string, prefix: string): string {
  return value.replace(new RegExp(`^${escapeRegExp(prefix)}`), '');
}
