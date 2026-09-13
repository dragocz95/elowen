/** The pure half of the interrupt ladder — window resolution, double-press arming and kill escalation.
 *  A leaf module on purpose: both the input shell (chatComposition) and the slash dispatcher
 *  (commands.ts) need it, and neither may import the other. */

/** Window used when no per-user setting reached the CLI (older daemon, offline boot). Matches
 *  `TERMINAL_DEFAULTS.interruptConfirmMs`, the source of the configured value. */
export const INTERRUPT_CONFIRM_MS = 1_800;

/** Bounds mirroring the daemon's own clamp (`INTERRUPT_CONFIRM_BOUNDS` in store/terminalSettings.ts),
 *  re-applied here because the value arrives over the wire from a daemon whose version the CLI does not
 *  control. Nothing about this window touches key DECODING: `\x1b[A` is reassembled into an arrow key by
 *  pi-tui's stdin buffer on its own byte-driven 10 ms timeout, long before any consumer sees an Esc, so
 *  shortening the confirmation window cannot split an escape sequence. */
const INTERRUPT_CONFIRM_BOUNDS: [min: number, max: number] = [500, 5000];

/** The effective double-Esc window for this session: the user's Account → Terminal value, held inside the
 *  bounds above, or the built-in default when the daemon served none. */
export function resolveInterruptConfirmMs(configured: number | undefined): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return INTERRUPT_CONFIRM_MS;
  const [min, max] = INTERRUPT_CONFIRM_BOUNDS;
  return Math.min(max, Math.max(min, Math.round(configured)));
}

/** Pure half of the double-Esc contract. The shell owns the expiry timer; this function makes the
 *  boundary deterministic in focused tests and prevents an old armed window from aborting a later turn. */
export function interruptPress(armedUntil: number, now: number, windowMs = INTERRUPT_CONFIRM_MS): { armedUntil: number; abort: boolean } {
  return armedUntil > now
    ? { armedUntil: 0, abort: true }
    : { armedUntil: now + windowMs, abort: false };
}

/** Pure half of the ESCALATING stop contract, layered over {@link interruptPress}. Once an abort has been
 *  requested for this turn (`stopRequested`), the turn may still be pinned by a long foreground command —
 *  PI's agent loop only re-checks its abort signal between tool calls — so a further Esc press escalates
 *  to a hard kill of that command instead of re-sending an abort the loop cannot act on. The escalation
 *  state lives client-side on purpose: the daemon never auto-escalates, so another client's innocent stop
 *  can never surprise-SIGKILL a running command. */
export function escalationPress(stopRequested: boolean, armedUntil: number, now: number, windowMs = INTERRUPT_CONFIRM_MS): { armedUntil: number; action: 'arm' | 'abort' | 'kill' } {
  if (stopRequested) return { armedUntil: 0, action: 'kill' };
  const next = interruptPress(armedUntil, now, windowMs);
  return { armedUntil: next.armedUntil, action: next.abort ? 'abort' : 'arm' };
}
