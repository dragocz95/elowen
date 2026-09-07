/** The live "what is the child doing" line a delegated run projects from its child's `tool` events — the
 *  sub-agent rail's row in the web telemetry panel and the CLI status line.
 *
 *  It used to be built from the tool name plus its salient argument, which reads like a stack frame:
 *  `Edit /var/www/.config/elowen/worktrees/…`. The model already authors a short human status note for
 *  exactly this purpose (`_reason`, or Bash's canonical `description`), and the host now settles it onto
 *  the `tool` event, so the note is what the row shows — `Upravuji soubor…` instead of a path. The derived
 *  label stays the fallback for a call that carried no note (a quick tool, or an older client).
 *
 *  One helper for all three call sites (Delegate, DelegateContinue and a workflow node) so the precedence
 *  has a single source; the model-facing running-subagents reminder deliberately shows none of it. */
export const liveToolDetail = (event) => {
  const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
  if (reason) return reason;
  return event.detail ? `${event.name} ${event.detail}` : event.name;
};
