import type { PulsePerson } from '../../lib/types';

export const HOURS = 24;

/** One colour per person, taken from the design tokens rather than a palette of this tile's own: the
 *  curve, the avatar dot and the table row all reuse the same value, which is what lets the chart go
 *  without a legend. Reading tokens (not literals) is also what keeps the tile on-brand under the Chetty
 *  skin, where the accent is not Elowen's ember. Beyond five people the colours repeat — deliberately,
 *  because a sixth hue that still reads as distinct on a dark surface does not exist for free. */
const SERIES = [
  'var(--color-accent)',
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-ember)',
] as const;

export const colorFor = (index: number): string => SERIES[index % SERIES.length] as string;

/** Recharts addresses a series by key, and a user id is the only stable handle a person has here — a
 *  display name can change mid-session and would silently detach the curve from its row. */
export const seriesKey = (person: PulsePerson): string => `u${person.userId}`;

/** Rotate a UTC-indexed 24-hour series into the reader's local day.
 *
 *  The daemon keys both `activity_buckets` and `memory_usage_events` on UTC hours, so every series
 *  arrives on one clock and one shift moves them all. Without this a Prague reader sees their evening
 *  peak drawn at afternoon. Zones offset by a half hour (India, Nepal) land on the nearest hour: the
 *  curve is an hourly rollup, so there is no half-hour bucket to be faithful to. */
export function toLocalHours(utcHours: readonly number[] | undefined): number[] {
  // A short-length or absent series is normalised to a flat day rather than trusted for its indices.
  // The browser can hold a newer bundle than the daemon it is talking to for the length of a restart,
  // and a missing series must draw as "no activity", not tear down the whole dashboard.
  const shift = -new Date().getTimezoneOffset() / 60;
  const out = Array<number>(HOURS).fill(0);
  for (let h = 0; h < HOURS; h += 1) {
    const local = (((Math.round(h + shift) % HOURS) + HOURS) % HOURS);
    out[local] = (out[local] ?? 0) + (utcHours?.[h] ?? 0);
  }
  return out;
}

export interface PulseChartRow {
  hour: number;
  /** Instance-wide memory recalls in this hour — drawn as the backdrop area. */
  memory: number;
  /** Per-person turn counts, keyed by {@link seriesKey}. */
  [personKey: string]: number;
}

/** One row per local hour, shaped the way Recharts wants it: every series is a key on the same object,
 *  so a hover resolves all of them at once and the tooltip can report the whole instance for that hour. */
export function buildChartRows(people: readonly PulsePerson[], memoryByHour: readonly number[]): PulseChartRow[] {
  const perPerson = people.map((p) => toLocalHours(p.hoursToday));
  const memory = toLocalHours(memoryByHour);
  return Array.from({ length: HOURS }, (_, hour) => {
    const row: PulseChartRow = { hour, memory: memory[hour] ?? 0 };
    people.forEach((person, i) => { row[seriesKey(person)] = perPerson[i]?.[hour] ?? 0; });
    return row;
  });
}

/** Percentage change against yesterday, or null when yesterday had nothing to compare with — an
 *  increase "from zero" is not a percentage, and rendering it as +100 % would overstate a first turn. */
export function deltaPct(today: number, yesterday: number): number | null {
  if (yesterday <= 0) return null;
  return ((today - yesterday) / yesterday) * 100;
}
