/** Browser MIRROR of `src/shared/cronSchedule.ts` (same governance as `web/lib/transcript.ts`): the web
 *  dock is a standalone bundle that cannot import the daemon's NodeNext source, so the cron-schedule
 *  grammar — itself a mirror of `parseSchedule` in plugins/cronjob/index.mjs — is hand-synced here.
 *  Keep all three in lockstep: a spec this file rejects is a job the user cannot edit, and one it accepts
 *  while the daemon rejects it is a save that 400s. */

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
    if (slices.length > 2) return false;
    const [range = '', stepText] = slices;
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1)) return false;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const bounds = range.split('-');
      if (bounds.length !== 2) return false;
      lo = num(bounds[0] ?? ''); hi = num(bounds[1] ?? '');
    } else {
      lo = num(range);
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
    && validCronField(fields[4] ?? '', 0, 6, WEEKDAYS, 7);
}

/** A recurring schedule the plugin can run: a human-readable form, or a cron expression. */
export function isValidSchedule(spec: string): boolean {
  const s = spec.trim();
  const every = /^every\s+(\d+)\s*(m|h)$/i.exec(s);
  if (every) return Number(every[1]) * (every[2]?.toLowerCase() === 'h' ? 60 : 1) >= 1;
  if (/^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s)) return true;
  if (/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s)) return true;
  return isValidCronExpression(s);
}
