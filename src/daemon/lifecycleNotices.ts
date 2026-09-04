import type { ServiceNotice } from '../plugins/api.js';

/** English wording for the daemon's own lifecycle announcements — pause, restart, coming back up.
 *
 *  This is the source of truth for the English text. Every adapter is handed it as the fallback, so an
 *  adapter that predates translated notices (or one configured in English) delivers exactly what the
 *  daemon has always sent. The Czech and Slovak renderings live in plugins/_shared/lifecycle.mjs, on the
 *  other side of a boundary this file cannot import across, and tests/contract/lifecycleMessageParity
 *  fails the moment the English half drifts from its mirror there. */
const NOTICES = {
  pausing: (turns: number, children: number) => turns + children > 0
    ? `⏸️ **Pausing** — ${turns} turn(s) and ${children} sub-agent(s) are checkpointed and resume after the restart.`
    : '⏸️ **Pausing** — Elowen is restarting; nothing was in flight.',
  backOnline: () => '✅ **Back online** — Elowen restarted and is ready.',
  backOnlineVersion: (version: string) => `✅ **Back online** — the daemon started (v${version}).`,
  restarting: () => '🔄 **Restart** — Elowen is restarting, back in a moment…',
  restartFailed: () => '⚠️ **Restart failed** — the daemon could not restart itself. Check the service logs.',
} as const;

export type LifecycleKey = keyof typeof NOTICES;

/** The English text plus the descriptor that lets an adapter say the same thing in its own language. */
export function lifecycleNotice<K extends LifecycleKey>(
  key: K,
  ...args: Parameters<(typeof NOTICES)[K]>
): { text: string; notice: ServiceNotice } {
  // The table's signatures form a union that TS cannot narrow from the generic key alone, though the
  // call site above is checked against the specific one.
  const render = NOTICES[key] as (...a: readonly unknown[]) => string;
  return { text: render(...args), notice: { key, args: [...args] as (string | number)[] } };
}

/** Render every notice with the given arguments — the parity test's view of the English half. */
export const LIFECYCLE_KEYS = Object.keys(NOTICES) as LifecycleKey[];
