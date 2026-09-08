/** The short NAME a delegation is labelled with — the sub-agent rail's row label, the handle the parent
 *  uses to address a child in the running-subagents reminder, and the identity DelegateList lists.
 *
 *  Every one of those rows used to be labelled with the child's whole task text, which is a briefing
 *  paragraph rather than a label: at a rail row's width it read as a wall of prose that told the reader
 *  nothing about which of three running children they were looking at.
 *
 *  A parent may pass its own `name` (Claude Code's Agent tool takes one for the same reason — a short,
 *  one-or-two-word handle its teams panel shows). When it passes none, the name is derived from the task's
 *  opening words, so a row is never left unlabelled and an older caller keeps working unchanged. */

/** Words of the task the derived name keeps. Five is what fits a rail row beside the status note and the
 *  trailing counters, and it is enough of an imperative sentence to identify the work. */
const MAX_NAME_WORDS = 5;
/** Hard ceiling in characters — the budget a rail row can spare for its label before the status note next
 *  to it has nothing left. Applies to a parent-supplied name too, which is otherwise unbounded input. */
const MAX_NAME_CHARS = 40;

/** Sentence punctuation at the end of a label reads as a truncation artefact rather than as prose, and a
 *  word-boundary clip lands on a comma often enough to be worth handling here rather than at each row. */
const stripTrailingPunctuation = (value) => value.replace(/[\s.,;:!?…–—-]+$/u, '');

/** Clip to the budget on a word boundary, falling back to a hard cut for a single over-long word. */
const clipToBudget = (value) => {
  if (value.length <= MAX_NAME_CHARS) return value;
  const head = value.slice(0, MAX_NAME_CHARS);
  const boundary = head.lastIndexOf(' ');
  return boundary > 0 ? head.slice(0, boundary) : head;
};

const oneLine = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

/** The name derived from a task's opening words. '' for a task with no words at all — an empty label is
 *  honest, where an invented one would put a placeholder on the row for the rest of the run. */
export function deriveSubagentName(task) {
  const words = oneLine(task).split(' ').filter(Boolean).slice(0, MAX_NAME_WORDS);
  if (words.length === 0) return '';
  return stripTrailingPunctuation(clipToBudget(words.join(' ')));
}

/** The name a delegation runs under: what the parent passed, else what the task yields. */
export function resolveSubagentName(explicit, task) {
  const given = oneLine(explicit);
  return given ? stripTrailingPunctuation(clipToBudget(given)) : deriveSubagentName(task);
}
