/** Base-URL primitives shared by every endpoint builder (embeddings, chat completions, app identity).
 *  Deliberately TWO primitives, not one combined "normalize" helper: the callers compose them
 *  differently. The openai-completions base must KEEP a trailing `/v1` (pi-ai appends
 *  `/chat/completions` to it), while the embeddings/chat URLs strip `/v1` before appending their own
 *  versioned path — a single normalize-with-flags function would only re-introduce the per-caller
 *  switch this module exists to avoid. */

/** Remove a single trailing slash so a suffix appends cleanly (`${base}/favicon.ico`). One slash only:
 *  `http://x//` keeps its inner slash, exactly like the `/\/$/` pattern it replaces. */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

/** Remove EVERY trailing slash. The name is spelled out because the difference from
 *  {@link trimTrailingSlash} is one character of regex and a real difference in output: an operator base
 *  URL of `https://x//` becomes `https://x` here and `https://x/` there.
 *
 *  This is the one the endpoint builders want. They append their own absolute path (`/responses`,
 *  `/codex/responses`), so any slash the operator left on the end would show up doubled in the URL that
 *  actually goes out. `trimTrailingSlash` keeps its single-slash behavior for the callers that compose
 *  differently — see the note at the top of this file on why these stay two primitives and not one
 *  function with a flag. */
export function trimAllTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Remove a trailing `/v1` API-version segment the operator may have included, so the caller's own
 *  versioned path is the only one on the URL. Case-sensitive — `/V1` is left alone. */
export function stripTrailingV1(value: string): string {
  return value.replace(/\/v1$/, '');
}
