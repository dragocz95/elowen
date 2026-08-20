/** The Ctrl+B seam: race delegated work against the user detaching it into the background.
 *
 *  Three call sites had their own copy of this race — a foreground delegation, a continuation, and a
 *  workflow — and a mistake in any of them hangs a turn, so they share one implementation.
 *
 *  `arm` receives the resolver to hang on whatever state object the out-of-band detach request will
 *  reach for (`state.resolveDetached`, `wf.resolveDetached`). It is called BEFORE `start`, so work that
 *  settles immediately can never beat the detach hook into place.
 *
 *  The loser is not cancelled. A detach means the parent stops WAITING; the child keeps running and
 *  delivers through the durable sink, which is the whole point of Ctrl+B. Neither branch can reject
 *  unobserved: Promise.race attaches handlers to both, and the detach promise only ever resolves.
 *
 *  What each caller does with a win — clear its job slot, wrap in ok(), arrange delivery — stays at the
 *  call site, because those genuinely differ and folding them in would need a flag per caller. */
export async function raceDetach(arm, start) {
  const detached = new Promise((resolve) => { arm(resolve); });
  const work = start();
  return Promise.race([
    work.then((value) => ({ detached: false, value })),
    detached.then(() => ({ detached: true, value: undefined })),
  ]);
}
