const HOUR_MS = 3_600_000;

/** Max gap (ms) between two identical events for them to collapse into one group. */
const GROUP_GAP_MS = 5 * 60 * 1000;

export interface AxisEvent {
  id: string;
  type: string;
  target: string;
  detail: string;
  timestamp: number;
}

/** A run of consecutive identical events collapsed into a single entry. */
export interface GroupedEvent extends AxisEvent {
  /** Number of raw events represented (1 when nothing was collapsed). */
  count: number;
  /** Timestamp of the earliest event in the run. */
  firstTimestamp: number;
}

export interface AxisPoint extends GroupedEvent {
  frac: number;
}

interface AxisTick {
  label: string;
  frac: number;
}

export interface AxisResult {
  ticks: AxisTick[];
  points: AxisPoint[];
}

/**
 * Collapse consecutive identical events (same type+target+detail within
 * `GROUP_GAP_MS`) into a single entry carrying a `count`. The deriver emits a
 * near-identical `working` signal every few seconds, so without this the feed
 * and axis flood with hundreds of duplicate rows.
 *
 * Input is sorted ascending by timestamp first, so "consecutive in time" is
 * well defined regardless of incoming order. Distinct events — or identical
 * events separated by more than the gap — stay separate.
 *
 * The returned entry keeps the latest event's `id`/`timestamp` (so it sorts to
 * the run's most-recent position) and exposes `firstTimestamp` for the run's
 * start. Pure: no side effects, input not mutated.
 */
export function groupEvents(events: AxisEvent[]): GroupedEvent[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const groups: GroupedEvent[] = [];

  for (const e of sorted) {
    const last = groups[groups.length - 1];
    const sameKind =
      last !== undefined &&
      last.type === e.type &&
      last.target === e.target &&
      last.detail === e.detail &&
      e.timestamp - last.timestamp <= GROUP_GAP_MS;

    if (sameKind) {
      last.count += 1;
      last.id = e.id;
      last.timestamp = e.timestamp;
    } else {
      groups.push({ ...e, count: 1, firstTimestamp: e.timestamp });
    }
  }

  return groups;
}

/**
 * Map a list of events onto a horizontal time axis. Events are grouped first
 * (see {@link groupEvents}) so repeated signals render as one marker.
 *
 * @param events  Raw event list with numeric `timestamp` (epoch ms).
 * @param now     Current epoch ms (injected so callers can test deterministically).
 * @param hours   Width of the window in hours.
 * @returns       `ticks` — one per hour from oldest to newest;
 *                `points` — grouped events inside the window with their X fraction.
 */
export function plotAxis(events: AxisEvent[], now: number, hours: number): AxisResult {
  const windowStart = now - hours * HOUR_MS;
  const span = now - windowStart;

  // Evenly-spaced ticks across the window. For ≤24h windows use one-per-hour with HH:MM
  // labels (so short ranges stay precise); for longer windows fall back to ~one-per-day
  // with a D.M. date label so a week-long axis doesn't flood with 168 ticks.
  const tickCount = hours <= 24 ? hours : Math.max(6, Math.min(12, Math.round(hours / 24)));
  const ticks: AxisTick[] = Array.from({ length: tickCount }, (_, i) => {
    const tickMs = windowStart + ((i + 1) * span) / tickCount;
    const d = new Date(tickMs);
    const label = hours <= 24
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${d.getDate()}.${d.getMonth() + 1}.`;
    const frac = (tickMs - windowStart) / span;
    return { label, frac };
  });

  // Group, then map to X fractions; drop anything outside [windowStart, now].
  const points: AxisPoint[] = groupEvents(events)
    .filter((e) => e.timestamp >= windowStart && e.timestamp <= now)
    .map((e) => ({
      ...e,
      frac: (e.timestamp - windowStart) / (now - windowStart),
    }));

  return { ticks, points };
}
