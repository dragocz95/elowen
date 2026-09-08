import { parseDbTs } from '../../shared/time.js';

/** How long a PLATFORM conversation (a Discord room, a cron job's own channel) may sit idle before the
 *  next message starts a FRESH session instead of continuing it. Past this the provider's prompt cache is
 *  long expired, so continuing would re-send the whole stale context at full price for no benefit.
 *
 *  Owner chat deliberately has NO such cutoff. A scheduled turn promises to answer in the conversation it
 *  was set from, and a dedicated job's history has to accumulate in one place, so silently moving the
 *  thread was never a trade owner chat could make; its stale-context cost is paid at turn start instead,
 *  by cold-start compaction and cold tool-result clearing. The constant is still owner chat's yardstick
 *  for how long an unwatched LIVE session may linger before the idle sweep disposes it (the durable
 *  conversation is untouched) — see BrainService's idle sweep and SessionTeardownService.
 */
export const SESSION_IDLE_ROLLOVER_MS = 30 * 60 * 1000;

/** Whether the next message should roll a platform conversation over into a fresh session. True only
 *  when the conversation HAS stored history (an empty session carries no stale context) and BOTH its
 *  newest message and the last explicit interaction with it (resume, model switch, compact,
 *  reasoning-effort change — see LiveBrain.interactedAt) are older than the cutoff. The caller gates
 *  on a running turn separately — a streaming session is never cut. `thresholdMs` defaults to
 *  SESSION_IDLE_ROLLOVER_MS (Discord rooms); a surface with a different cache profile (cron's
 *  frequent jobs) may pass a shorter one — the single decision function stays the source of truth. */
export function rolloverDue(
  o: { lastMessageAt: string | undefined; interactedAt: number | undefined; now: number },
  thresholdMs: number = SESSION_IDLE_ROLLOVER_MS,
): boolean {
  const lastMs = parseDbTs(o.lastMessageAt);
  if (lastMs === 0) return false; // no stored messages (or unparseable) — nothing stale to cut loose
  const lastActivity = Math.max(lastMs, o.interactedAt ?? 0);
  return o.now - lastActivity >= thresholdMs;
}
