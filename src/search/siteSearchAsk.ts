/** The "Ask AI" half of site-wide search: when neither the lexical nor the semantic pass found anything,
 *  one cheap completion is asked to pick the pages that answer the query.
 *
 *  It runs on the workspace CATEGORIZATION route (Settings → Memory), through `piInferenceClient` — the
 *  brain's own provider stack — so an OAuth account (Claude, Codex) works here exactly like an API-key
 *  endpoint does. That matters: embeddings are API-key-only, so an OAuth-only instance has no semantic
 *  layer at all and this is the only assistance the palette can offer it.
 *
 *  The model never routes the user anywhere by itself. It returns candidate IDS, every one of which is
 *  checked against the list that was sent — an id the model invented is dropped, not followed. */

/** How many suggestions one ask may produce. A model asked for "the best few" and given a cap answers
 *  more usefully than one asked for an unbounded ranking, and the palette shows them as a short group. */
export const SEARCH_ASK_MAX_RESULTS = 5;

/** Hard cap on one ask round-trip. The user is watching a spinner inside an open palette — past this the
 *  answer has stopped being an answer. Deliberately far below the shared completion ceiling in
 *  piInference.ts (three minutes), which is sized for background work nobody is waiting on. */
export const SEARCH_ASK_TIMEOUT_MS = 15_000;

/** One page the model may choose. `title`/`subtitle` are what the palette renders, so the model reads
 *  exactly what the user would have read. */
export interface AskCandidate {
  id: string;
  title: string;
  subtitle?: string;
}

/** The prompt: the candidate list as `id — title · subtitle` lines, then the query. The reply contract is
 *  stated twice (what to answer with, and what not to add) because a single line of it is the difference
 *  between a parseable array and a paragraph explaining the array. */
export function buildAskPrompt(query: string, candidates: readonly AskCandidate[]): string {
  return [
    'You are the search assistant for an application\'s command palette. The user typed a query that',
    'matched no page by text. Choose the pages from the list below that best answer what they are',
    'looking for.',
    '',
    `Reply with ONLY a JSON array of at most ${SEARCH_ASK_MAX_RESULTS} ids from the list, best first —`,
    'for example ["settings:brain","page:memory"]. Use no code fence, no explanation, no other text.',
    'Use ONLY ids that appear in the list. If nothing in the list fits, reply with [].',
    '',
    'Pages:',
    ...candidates.map((candidate) => `${candidate.id} — ${candidate.title}${candidate.subtitle ? ` · ${candidate.subtitle}` : ''}`),
    '',
    `Query: ${query}`,
  ].join('\n');
}

/** Strictly parse the model's reply into KNOWN candidate ids.
 *
 *  Strict about the SHAPE — the reply must be a JSON array, and only its string members are considered —
 *  and strict about the ids: anything the candidate list does not contain is dropped rather than
 *  guessed at, so a hallucinated id can never become a route. Duplicates collapse, order is the model's,
 *  and the result is capped at {@link SEARCH_ASK_MAX_RESULTS}. Never throws: an unparseable reply is an
 *  empty answer, which the palette already has a state for.
 *
 *  A surrounding ``` fence is stripped before parsing — the same allowance the memory categorizer makes,
 *  for the same reason: models add one habitually, and it is packaging rather than a different answer. */
export function parseAskReply(reply: string, candidates: readonly AskCandidate[]): string[] {
  const known = new Set(candidates.map((candidate) => candidate.id));
  const cleaned = reply
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const picked: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || !known.has(item) || picked.includes(item)) continue;
    picked.push(item);
    if (picked.length === SEARCH_ASK_MAX_RESULTS) break;
  }
  return picked;
}
