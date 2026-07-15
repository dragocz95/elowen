/** Whether a cron-job schedule spec is one the scheduler will actually run.
 *
 *  The daemon cannot import the cronjob plugin's untyped ESM entry, so this is a hand-synced mirror of
 *  `parseSchedule` / `parseCronField` in plugins/cronjob/index.mjs — the SAME grammar, only answering
 *  "would that parse?" instead of building the matcher. The web dock carries its own mirror
 *  (`web/lib/cronSchedule.ts`, a standalone bundle that cannot import this file); keep all three in
 *  lockstep.
 *
 *  Getting this wrong is not cosmetic: a spec the API accepts but the plugin rejects is a job that is
 *  stored and never fires, and a spec the plugin accepts but the API rejects is a job nobody can edit. */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** One cron field: `*`, a value, a range, any of those with a `/step`, and comma-separated lists of them.
 *  `names` are folded to numbers FROM the field's own minimum (sun=0, jan=1); `wrapValue` is the one
 *  extra accepted value above `max` (cron's Sunday, which is both 0 and 7). */
function validCronField(spec: string, min: number, max: number, names?: readonly string[], wrapValue?: number): boolean {
  const text = spec.trim().toLowerCase();
  if (!text) return false;
  const ceiling = wrapValue === undefined ? max : wrapValue;
  const num = (token: string): number => {
    const named = names ? names.indexOf(token) : -1;
    return named >= 0 ? named + min : (/^\d+$/.test(token) ? Number(token) : NaN);
  };
  for (const part of text.split(',')) {
    const slices = part.split('/');
    if (slices.length > 2) return false; // "1-5/2/3" is not a thing
    const [range = '', stepText] = slices;
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1)) return false;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const bounds = range.split('-');
      if (bounds.length !== 2) return false; // "1-3-5" is malformed, not silently "1-3"
      lo = num(bounds[0] ?? ''); hi = num(bounds[1] ?? '');
    } else {
      lo = num(range);
      // A bare value with a step means "from here to the end" (`5/15` = 5,20,35,50) — standard cron.
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return false;
    if (lo < min || hi > ceiling) return false;
  }
  return true;
}

/** A standard 5-field cron expression: minute hour day-of-month month day-of-week ("0 9 * * 1-5"). */
function isValidCronExpression(spec: string): boolean {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return validCronField(fields[0] ?? '', 0, 59)
    && validCronField(fields[1] ?? '', 0, 23)
    && validCronField(fields[2] ?? '', 1, 31)
    && validCronField(fields[3] ?? '', 1, 12, MONTHS)
    && validCronField(fields[4] ?? '', 0, 6, WEEKDAYS, 7); // 7 is cron's other name for Sunday
}

/** A recurring schedule the plugin can run: a human-readable form, or a cron expression. One-shot jobs
 *  carry a `runAt` instant instead and never come through here. */
export function isValidSchedule(spec: string): boolean {
  const s = spec.trim();
  const every = /^every\s+(\d+)\s*(m|h)$/i.exec(s);
  if (every) return Number(every[1]) * (every[2]?.toLowerCase() === 'h' ? 60 : 1) >= 1;
  if (/^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s)) return true;
  if (/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s)) return true;
  return isValidCronExpression(s);
}
