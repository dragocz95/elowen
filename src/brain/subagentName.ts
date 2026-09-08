/** The short NAME a delegation is labelled with, as the daemon's own read models need it.
 *
 *  Deliberate mirror of `plugins/subagent/lib/name.mjs`: the plugin owns the name at WRITE time (it is
 *  what lands in a run row's `name`), but a row written before that field existed carries none, and the
 *  conversation tree still has to label it. The daemon may not import a plugin's ESM, so the rule is
 *  restated here with the same words and the same arithmetic, and tests/brain/subagentName.test.ts pins
 *  the two together character for character.
 *
 *  Restating it is the point: the alternative is a second fallback that calls one child something else in
 *  the switcher than the rail and the reminder call it. */

/** Words of the task the derived name keeps — see the plugin's note: five is what identifies the work. */
const MAX_NAME_WORDS = 5;
/** Hard ceiling in characters. Applies to an explicit name too, which is otherwise unbounded input. */
const MAX_NAME_CHARS = 40;

const stripTrailingPunctuation = (value: string): string => value.replace(/[\s.,;:!?…–—-]+$/u, '');

const clipToBudget = (value: string): string => {
  if (value.length <= MAX_NAME_CHARS) return value;
  const head = value.slice(0, MAX_NAME_CHARS);
  const boundary = head.lastIndexOf(' ');
  return boundary > 0 ? head.slice(0, boundary) : head;
};

const oneLine = (value: unknown): string => String(value ?? '').replace(/\s+/gu, ' ').trim();

/** The name derived from a task's opening words. '' when the task has no words at all — an empty label is
 *  honest, where an invented one would put a placeholder on the row forever. */
export function deriveSubagentName(task: unknown): string {
  const words = oneLine(task).split(' ').filter(Boolean).slice(0, MAX_NAME_WORDS);
  if (words.length === 0) return '';
  return stripTrailingPunctuation(clipToBudget(words.join(' ')));
}

/** The name a delegation runs under: what was stored for it, else what its task yields. */
export function resolveSubagentName(explicit: unknown, task: unknown): string {
  const given = oneLine(explicit);
  return given ? stripTrailingPunctuation(clipToBudget(given)) : deriveSubagentName(task);
}
