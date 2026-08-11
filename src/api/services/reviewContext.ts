/** How much of the working-tree diff is handed to the overseer inline. A sequential mission's diff is
 *  usually small; the cap only guards against a pathological change set blowing the overseer's context.
 *  When the diff is truncated the overseer is told it may pull the rest via read-only git. */
export const REVIEW_DIFF_LIMIT = 16000;

/** Assemble the review decision context: the agent's self-reported outcome PLUS the real evidence
 *  (changed files + the actual `git diff HEAD`), so the overseer judges the changes, not the summary.
 *  Pure and synchronous — the caller fetches the git data; this only shapes and bounds it. */
export function buildReviewContext(
  input: { title: string; outcome: string; summary: string; changedFiles: string[]; diff: string },
  limit = REVIEW_DIFF_LIMIT,
): Record<string, unknown> {
  const truncated = input.diff.length > limit;
  return {
    title: input.title,
    outcome: input.outcome,
    summary: input.summary,
    changedFiles: input.changedFiles,
    diff: truncated ? input.diff.slice(0, limit) : input.diff,
    diffTruncated: truncated,
  };
}
