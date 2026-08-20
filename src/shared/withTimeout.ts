/** Bound a wait: settle with `work`, or reject with `message` once `ms` elapses.
 *
 *  Only for callers whose timeout is a FAILURE. The daemon also has two races that RESOLVE on expiry —
 *  PluginHookBus skips a slow hook and ApplicationLifetime gives up on a drain — and those deliberately
 *  keep their own races: folding them in here would mean an `onTimeout` value or a sentinel branch, which
 *  is the caller-specific switch this helper exists to avoid.
 *
 *  The loser keeps running. `work` is not cancelled — nothing here can cancel it — so a caller that must
 *  actually stop the work does that itself (statusService aborts its session in a finally). The timer is
 *  always cleared, and unref'd besides, so a bounded wait can neither leak a pending timer nor hold the
 *  process open past the work it was watching. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([work, expiry]).finally(() => { if (timer) clearTimeout(timer); });
}
