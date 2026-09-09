import { parseDbTs } from '../shared/time.js';
import type { MemoryVitalityHistory, MemoryVitalityPoint } from '../shared/wireContract.js';
import {
  isEvictable,
  vitality,
  type MemoryRetentionConfig,
  type VitalityMemory,
} from './memoryVitality.js';

/** Rebuilds a memory's vitality over time from its recall log, and projects where it is heading.
 *
 *  Vitality itself is not stored — it is a pure function of (importance, use_count, last_used_at, now),
 *  which means two stored numbers can only ever answer "what is it worth NOW". `memory_usage_events`
 *  records one row per recall, and replaying that log recovers what the two counters WERE at any past
 *  instant, so the curve below is reconstructed rather than guessed.
 *
 *  The reconstruction is exact only back to the point where the counters stop being ambiguous:
 *  - a memory whose logged recalls account for its whole use_count is exact from its creation;
 *  - one that was already used before logging existed (or whose oldest events have since been pruned)
 *    is exact only from its first surviving event — before that we know a recall happened but not when.
 *  Everything earlier is left undrawn instead of being invented. */

const DAY_MS = 86_400_000;

/** Points on the reconstructed past. Enough to look like a curve at drawer width without making the
 *  response large; recall instants are added on top, up to {@link MAX_RECALL_MARKS}, so a spike between
 *  samples is not missed. */
const PAST_SAMPLES = 48;
/** The forecast is a smooth decay with no events in it, so it needs far fewer points. */
const FORECAST_SAMPLES = 16;
/** How many recall instants the window may contribute, to `points` and to `recalls` alike.
 *
 *  Without a bound these two arrays are as long as the recall log itself, and the drawer draws one chart
 *  element per mark: a memory recalled 1135 times in the window blocked the browser's main thread for
 *  13.9 seconds on open and answered with a 103 kB body for a 168px plot. Bounded, the same memory costs
 *  0.1s and 8 kB. The cap is PAST_SAMPLES, because a mark the sampled curve cannot resolve is one the
 *  reader cannot resolve either — at drawer width the marks merge into a solid band long before this
 *  many, so what is lost above the cap is ink rather than information. */
const MAX_RECALL_MARKS = PAST_SAMPLES;
/** How far ahead the forecast may run, and how far the eviction scan looks before giving up. */
const MAX_FORECAST_DAYS = 90;
const MAX_EVICTION_SCAN_DAYS = 365;

export interface VitalityHistoryInput {
  memory: VitalityMemory;
  /** Recall timestamps as stored (SQLite or ISO), any order. */
  recalls: readonly string[];
  retention: MemoryRetentionConfig;
  now: number;
  /** How far back the window reaches. */
  pastDays: number;
}

/** The memory as it stood at `at`, given how many recalls had happened by then. */
function stateAt(memory: VitalityMemory, useCount: number, lastUsedMs: number | null): VitalityMemory {
  return {
    importance: memory.importance,
    use_count: useCount,
    last_used_at: lastUsedMs === null ? null : new Date(lastUsedMs).toISOString(),
    created_at: memory.created_at,
  };
}

/** At most `max` items, evenly spaced by position and keeping the first and the last.
 *
 *  Thinning rather than truncating: the marks say WHEN a memory was recalled, so dropping the tail would
 *  end them weeks short of now and read as "not recalled since" — the opposite of what a heavily recalled
 *  memory is doing. Spacing by position also preserves relative density, so a busy stretch still looks
 *  busier than a quiet one. */
function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => items[Math.round(index * step)]!);
}

function sampleTimes(fromMs: number, toMs: number, count: number): number[] {
  if (toMs <= fromMs) return [toMs];
  const step = (toMs - fromMs) / (count - 1);
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) times.push(Math.round(fromMs + step * index));
  return times;
}

/** First instant the retention sweep would evict this memory, scanning a day at a time. A closed form
 *  would have to invert the decay AND the grace period together; a bounded daily scan is exact enough
 *  for a date shown to a human and cannot disagree with {@link isEvictable}, because it asks it. */
function findEvictAt(
  memory: VitalityMemory,
  useCount: number,
  lastUsedMs: number | null,
  retention: MemoryRetentionConfig,
  now: number,
): number | null {
  const frozen = stateAt(memory, useCount, lastUsedMs);
  for (let day = 0; day <= MAX_EVICTION_SCAN_DAYS; day += 1) {
    const at = now + day * DAY_MS;
    if (isEvictable(frozen, retention, at)) return at;
  }
  return null;
}

export function buildVitalityHistory(input: VitalityHistoryInput): MemoryVitalityHistory {
  const { memory, retention, now, pastDays } = input;

  const recallMs = input.recalls
    .map((stamp) => parseDbTs(stamp))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);

  // Recalls that predate the log (or were pruned out of it) are still inside the stored counter. Keeping
  // them as a baseline is what makes the curve land exactly on the vitality shown next to it, and it
  // self-corrects as old events are pruned.
  const baseline = Math.max(0, memory.use_count - recallMs.length);
  const createdMs = parseDbTs(memory.created_at);

  // With no unexplained prior uses, the memory demonstrably sat at zero recalls until its first logged
  // one, so the curve is honest all the way back to creation.
  const historyFromMs = baseline === 0
    ? (createdMs > 0 ? createdMs : recallMs[0] ?? null)
    : recallMs[0] ?? null;

  const windowStartMs = Math.max(now - pastDays * DAY_MS, createdMs > 0 ? createdMs : 0);
  const pastStartMs = historyFromMs === null ? null : Math.max(windowStartMs, historyFromMs);

  const inWindow = thin(
    recallMs.filter((ms) => (pastStartMs !== null && ms >= pastStartMs) && ms <= now),
    MAX_RECALL_MARKS,
  );

  const points: MemoryVitalityPoint[] = [];
  if (pastStartMs !== null && pastStartMs < now) {
    const times = [...new Set([...sampleTimes(pastStartMs, now, PAST_SAMPLES), ...inWindow])]
      .sort((a, b) => a - b);
    for (const at of times) {
      const priorRecalls = recallMs.filter((ms) => ms <= at);
      const lastRecall = priorRecalls.length > 0 ? priorRecalls[priorRecalls.length - 1] ?? null : null;
      points.push({
        at: new Date(at).toISOString(),
        vitality: vitality(stateAt(memory, baseline + priorRecalls.length, lastRecall), retention, at),
      });
    }
  }

  const lastRecallMs = recallMs.length > 0 ? recallMs[recallMs.length - 1] ?? null : parseDbTs(memory.last_used_at) || null;
  const evictAtMs = findEvictAt(memory, memory.use_count, lastRecallMs, retention, now);
  // The forecast stops at the crossing: past it the memory would already be in the trash, so drawing
  // further would show a life it will not have. A memory that is ALREADY evictable collapses to the
  // single point at `now` for the same reason.
  const horizonMs = now + MAX_FORECAST_DAYS * DAY_MS;
  const forecastEndMs = Math.max(now, Math.min(evictAtMs ?? horizonMs, horizonMs));
  const frozen = stateAt(memory, memory.use_count, lastRecallMs);
  const forecast = sampleTimes(now, forecastEndMs, FORECAST_SAMPLES)
    .map((at) => ({ at: new Date(at).toISOString(), vitality: vitality(frozen, retention, at) }));

  return {
    points,
    forecast,
    recalls: inWindow.map((ms) => new Date(ms).toISOString()),
    floor: retention.vitalityFloor,
    evictAt: evictAtMs === null ? null : new Date(evictAtMs).toISOString(),
    historyFrom: historyFromMs === null ? null : new Date(historyFromMs).toISOString(),
    now: new Date(now).toISOString(),
  };
}
