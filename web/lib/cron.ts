/** Weekday tokens as used by the cronjob plugin's `weekly <day> HH:MM` schedule (index = getDay()). */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A parsed 5-field cron expression: each field is the set of values it matches. */
interface CronParsed {
  kind: 'cron';
  minute: Set<number>; hour: Set<number>; dayOfMonth: Set<number>; month: Set<number>; dayOfWeek: Set<number>;
  domRestricted: boolean; dowRestricted: boolean;
}

type Parsed =
  | { kind: 'interval'; ms: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | CronParsed;

/** Parse ONE cron field into the set of values it matches — mirror of `parseCronField` in the cronjob
 *  plugin's schedule engine. Null on anything malformed so the caller rejects the whole expression.
 *
 *  VALIDATION ONLY, deliberately deprecated: this web copy existed so the old browser bundles could
 *  validate a schedule and expand its next runs without a round-trip. The next-run expansion is gone —
 *  every future occurrence now comes from the plugin's server projection (`nextOccurrence` on the job),
 *  which reads the scheduler's own timezone, active-hours and catch-up rules instead of a second
 *  hand-synced browser copy of them that quietly disagreed. What is left here is the validity view the
 *  still-released API 12 bundles reach through `window.ElowenUiRuntime.utils.isValidSchedule`; the new
 *  cronjob UI never calls it. Removing it is a deliberately breaking plugin UI contract. */
function parseCronField(spec: string, min: number, max: number, names?: string[], wrapValue?: number): Set<number> | null {
  const text = String(spec ?? '').trim().toLowerCase();
  if (!text) return null;
  const values = new Set<number>();
  const ceiling = wrapValue === undefined ? max : wrapValue;
  const wrap = (v: number) => (v === wrapValue ? min : v);
  const num = (token: string): number => {
    const named = names ? names.indexOf(token) : -1;
    const n = named >= 0 ? named + min : (/^\d+$/.test(token) ? Number(token) : NaN);
    return Number.isInteger(n) ? n : NaN;
  };
  for (const part of text.split(',')) {
    const slices = part.split('/');
    if (slices.length > 2) return null;
    const [range, stepText] = slices;
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const bounds = range.split('-');
      if (bounds.length !== 2) return null;
      lo = num(bounds[0]); hi = num(bounds[1]);
    } else {
      lo = num(range);
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return null;
    if (lo < min || hi > ceiling) return null;
    for (let v = lo; v <= hi; v += step) values.add(wrap(v));
  }
  return values.size ? values : null;
}

/** Parse a standard 5-field cron expression, or null when it is not five valid fields. Mirror of the
 *  plugin's `parseCron`. */
function parseCron(spec: string): CronParsed | null {
  const fields = String(spec ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12, MONTHS);
  const dayOfWeek = parseCronField(fields[4], 0, 6, WEEKDAYS, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return {
    kind: 'cron', minute, hour, dayOfMonth, month, dayOfWeek,
    domRestricted: !fields[2].trim().startsWith('*'),
    dowRestricted: !fields[4].trim().startsWith('*'),
  };
}

/** Parse the plugin's schedule grammar — `every 15m` / `every 2h` / `daily 07:30` / `weekly sun 20:00`,
 *  or a standard 5-field cron expression. Deliberately a small mirror of `parseSchedule` in the
 *  registry's cronjob plugin (kept in lockstep with it). Null = invalid. */
function parseSchedule(spec: string): Parsed | null {
  let m = /^every\s+(\d+)\s*(m|h)$/i.exec(spec.trim());
  if (m) {
    const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000);
    return ms < 60_000 ? null : { kind: 'interval', ms };
  }
  m = /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]) };
  m = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'weekly', day: WEEKDAYS.indexOf(m[1].toLowerCase()), hour: Number(m[2]), minute: Number(m[3]) };
  return parseCron(spec);
}

/** Whether `spec` is a valid schedule the scheduler will run — the validation-only view of
 *  `parseSchedule`, under the same name the daemon's API validator `src/shared/cronSchedule.ts` exports
 *  (that file remains a separate mirror of the same grammar, as does the plugin's `parseSchedule`).
 *
 *  COMPATIBILITY-ONLY export, published to plugin bundles as `utils.isValidSchedule`. The browser
 *  never validates a new form against it: the cronjob UI asks the plugin's `schedule-preview` route,
 *  so a schedule is always judged by the engine that will run it. */
export function isValidSchedule(spec: string): boolean {
  return parseSchedule(spec) !== null;
}
