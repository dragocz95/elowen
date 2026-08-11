/** Parse a SQLite ("2026-06-19 11:13:20", space-separated UTC, no zone) or ISO timestamp to epoch
 *  ms. Returns 0 for an empty/null/unparseable value — callers treat 0 as "no usable time". SQLite
 *  emits a zone-less space form, so it's normalised to ISO and tagged UTC, but only when the value
 *  doesn't already carry a zone (a 'T' separator or trailing 'Z'), so an already-UTC string never
 *  gets a second 'Z' (which would yield an Invalid Date). Single source of truth for DB-string parsing. */
export function parseDbTs(ts?: string | null): number {
  if (!ts) return 0;
  const norm = ts.includes('T') ? ts : ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z');
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Normalise a SQLite/ISO DB timestamp to a canonical ISO-8601 (UTC) string. Routes through
 *  {@link parseDbTs} so a value already carrying a zone never gets a second 'Z' (Invalid Date). An
 *  unparseable input yields the epoch ISO rather than throwing — SQLite always emits a valid space form,
 *  so callers converting stored rows for display never hit that. */
export function dbTsToIso(ts: string): string {
  return new Date(parseDbTs(ts)).toISOString();
}
