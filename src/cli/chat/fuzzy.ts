/** Fuzzy matching shared by the slash-command suggestion overlay and the `/model <name>` resolver.
 *  Kept as pure functions so both surfaces score identically and stay unit-testable without a TTY. */

/** Score a query against a candidate `name` (and optional `description`). Higher is better:
 *  exact=100, prefix=80, substring=60, description-substring=35, subsequence=20, no match=0.
 *  An empty query matches everything weakly (1). Case-insensitive; the query is trimmed. */
export function fuzzyScore(query: string, name: string, description = ''): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  if (description.toLowerCase().includes(q)) return 35;
  let position = 0;
  for (const character of q) {
    position = n.indexOf(character, position);
    if (position === -1) return 0;
    position += 1;
  }
  return 20;
}

export interface ModelOption { provider: string; providerLabel: string; model: string; free?: boolean }

/** The smallest score we auto-apply for `/model <name>`. Substring or better ("opus" → claude-opus)
 *  switches directly; a weaker subsequence-only guess falls through so the caller can open the picker
 *  instead of silently jumping to a surprising model. */
const AUTO_APPLY_MIN_SCORE = 60;

/** Score every model against `query` (matching the id with and without a trailing `:free`), best first.
 *  Tie-break: higher score, then paid over free, then original list order (providers[0] is the default). */
export function scoreModels(models: ModelOption[], query: string): { option: ModelOption; score: number }[] {
  return models
    .map((option, index) => ({
      option,
      index,
      score: Math.max(fuzzyScore(query, option.model), fuzzyScore(query, option.model.replace(/:free$/, ''))),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(Boolean(a.option.free)) - Number(Boolean(b.option.free)) || a.index - b.index)
    .map(({ option, score }) => ({ option, score }));
}

/** Resolve a free-text `/model` argument to a concrete (provider, model) selection, or null when no
 *  match is confident enough to auto-apply (the caller then opens the picker). */
export function resolveModelQuery(models: ModelOption[], query: string): { provider: string; model: string } | null {
  const best = scoreModels(models, query)[0];
  if (!best || best.score < AUTO_APPLY_MIN_SCORE) return null;
  return { provider: best.option.provider, model: best.option.model };
}
