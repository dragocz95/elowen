import { parseDbTs } from '../../shared/time.js';

/** How long a conversation may sit idle (no new messages, no explicit user interaction) before the
 *  next message starts a FRESH session instead of continuing it. Past this the provider's prompt
 *  cache is long expired, so continuing would re-send the whole stale context at full price for no
 *  benefit — a new conversation is both cheaper and cleaner. */
export const SESSION_IDLE_ROLLOVER_MS = 30 * 60 * 1000;

/** Whether the next user message should roll the conversation over into a fresh session. True only
 *  when the conversation HAS stored history (an empty session carries no stale context) and BOTH its
 *  newest message and the user's last explicit interaction with it (resume, model switch, compact,
 *  reasoning-effort change — see LiveBrain.interactedAt) are older than the cutoff. The caller gates
 *  on a running turn separately — a streaming session is never cut. `thresholdMs` defaults to
 *  SESSION_IDLE_ROLLOVER_MS (owner chat + Discord); a surface with a different cache profile (cron's
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
