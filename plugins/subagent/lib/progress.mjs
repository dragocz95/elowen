/** The live "what is the child doing" line a delegated run projects from its child's `tool` events — the
 *  sub-agent rail's row in the web telemetry panel and the CLI status line.
 *
 *  It used to be built from the tool name plus its salient argument, which reads like a stack frame:
 *  `Edit /var/www/.config/elowen/worktrees/…`. The model already authors a short human status note for
 *  exactly this purpose (`_reason`, or Bash's canonical `description`), and the host now settles it onto
 *  the `tool` event, so the note is what the row shows — `Upravuji soubor…` instead of a path.
 *
 *  The note is STICKY. A model authors one on the calls that take a noticeable moment and deliberately
 *  omits it on the quick ones in between, so reading each call in isolation left the row on the derived
 *  path label for most of a run. The last authored note therefore stands until a newer one arrives, and
 *  the derived label is reached for only while this delegation has never authored a note at all.
 *
 *  One helper for all three call sites (Delegate, DelegateContinue and a workflow node) so the precedence
 *  has a single source; the model-facing running-subagents reminder deliberately shows none of it.
 *
 *  @param event the child's `tool` start event
 *  @param sticky the note this row already carries — '' while the delegation has authored none
 *  @returns `{ reason, detail }`: the note to carry into the next call, and the line to display now
 */
export const foldToolDetail = (event, sticky) => {
  const authored = typeof event.reason === 'string' ? event.reason.trim() : '';
  const carried = typeof sticky === 'string' ? sticky.trim() : '';
  const reason = authored || carried;
  if (reason) return { reason, detail: reason };
  return { reason: '', detail: event.detail ? `${event.name} ${event.detail}` : event.name };
};

/** Merge one core-computed usage snapshot into a durable delegated progress row. The explicit turn/model
 * identity is the stale-value fence: a new identity clears the prior speed even before the new turn has a
 * valid sample; a same-identity tool/status snapshot without a sample retains the last measured aggregate. */
export const foldEffectiveUsage = (state, usage) => {
  if (!usage || typeof usage !== 'object') return;
  if (Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) state.tokens = usage.totalTokens;
  const turnId = typeof usage.effectiveTurnId === 'string' && usage.effectiveTurnId ? usage.effectiveTurnId : undefined;
  const model = typeof usage.effectiveModel === 'string' ? usage.effectiveModel : undefined;
  if (turnId && (state.effectiveTurnId !== turnId || state.effectiveModel !== model)) {
    state.effectiveTps = undefined;
    state.effectiveTurnId = turnId;
    state.effectiveModel = model;
  }
  if (typeof usage.effectiveTps === 'number' && Number.isFinite(usage.effectiveTps) && usage.effectiveTps > 0) {
    state.effectiveTps = usage.effectiveTps;
    if (turnId) state.effectiveTurnId = turnId;
    if (model !== undefined) state.effectiveModel = model;
  }
};
