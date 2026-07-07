// ask_user_question reply parsing (numbered text menus — see the buttons caveat in index.mjs).
/** Parse a text reply to a single parked ask question. Pure — exported for tests. Returns
 *  `{ kind: 'picks', labels }` for a valid number (or comma list on a multiSelect question),
 *  `{ kind: 'other', text }` for free text when the question allows it (`custom !== false`,
 *  absent = allowed), or null when the reply is not a usable answer (→ re-prompt). */
export function parseAskReply(text, question) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const opts = question.options ?? [];
  const parts = t.split(',').map((s) => s.trim());
  if (parts.every((s) => /^\d+$/.test(s))) {
    const nums = parts.map(Number);
    const inRange = nums.every((n) => n >= 1 && n <= opts.length);
    // A comma list only counts as picks on a multiSelect question; a single number always does.
    if (inRange && (question.multiSelect === true || nums.length === 1)) {
      return { kind: 'picks', labels: [...new Set(nums.map((n) => opts[n - 1].label))] };
    }
  }
  if (question.custom !== false) return { kind: 'other', text: t };
  return null;
}
