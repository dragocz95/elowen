import type { CronJob } from './types';

/** Weekday tokens as used by the cronjob plugin's `weekly <day> HH:MM` schedule (index = getDay()). */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

type Parsed =
  | { kind: 'interval'; ms: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number };

/** Parse the plugin's schedule grammar — `every 15m` / `every 2h` / `daily 07:30` / `weekly sun 20:00`.
 *  Deliberately a small mirror of `parseSchedule` in plugins/cronjob/index.mjs (kept in lockstep with
 *  it); the same duplication already exists for `isValidCronSchedule` on the daemon side. Null = invalid. */
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
  return null;
}

/** The next time a cron job will fire, in epoch ms — or null when it never will (disabled, spent
 *  one-shot, or an unparseable schedule). The soonest future-or-imminent fire: an overdue interval or
 *  a never-run job resolves to `now` (it fires on the next scheduler tick). Mirrors the plugin's
 *  `isDue` logic but computes the timestamp instead of a boolean. */
export function nextCronRun(job: CronJob, now: number): number | null {
  if (job.enabled === false) return null;
  // One-shot wake-up: fires exactly once at runAt, then the plugin deletes it. Already run → gone.
  if (job.runAt) {
    if (job.lastRun) return null;
    const at = Date.parse(job.runAt);
    return Number.isNaN(at) ? null : Math.max(at, now);
  }
  const sched = parseSchedule(job.schedule);
  if (!sched) return null;
  const last = job.lastRun ? Date.parse(job.lastRun) : 0;

  if (sched.kind === 'interval') {
    return Math.max((Number.isNaN(last) ? 0 : last) + sched.ms, now);
  }

  // daily / weekly: the next clock occurrence of HH:MM (on the right weekday), at or after now.
  const at = new Date(now);
  at.setHours(sched.hour, sched.minute, 0, 0);
  if (sched.kind === 'weekly') {
    const ahead = (sched.day - at.getDay() + 7) % 7;
    at.setDate(at.getDate() + ahead);
  }
  if (at.getTime() <= now) at.setDate(at.getDate() + (sched.kind === 'weekly' ? 7 : 1));
  return at.getTime();
}
