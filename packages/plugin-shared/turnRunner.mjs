// The orchestration every chat adapter wraps around ONE brain call: route the turn's events, hold the
// typing indicator up, mark the triggering message as seen, deliver the answer through the live stream or
// a plain send, and settle the status marker — including the failure path, which has to reach the person
// who asked AND the operator's log.
//
// Five copies of this block existed (Discord twice, Teams, Telegram, WhatsApp) and they had already
// drifted in ways nobody chose: only Teams logged a failed turn, only Teams waited for the "seen" reaction
// to land before removing it, and only WhatsApp cleared its typing state. This is the same split the live
// stream already uses — the ENGINE owns sequence and error handling, the adapter supplies the platform
// verbs — so a fix lands once instead of five times, minus one.
//
// What is deliberately NOT here: building the handler arguments (every platform's envelope is different
// and Teams wraps the call in `accountLinking.runWithActivity`), rendering, and the config gate that
// decides whether a turn may be decorated at all. The adapter passes `run` and resolves `reactions` to
// null when it must not decorate anything.
import { isSteered } from './turnResult.mjs';

/** How often the typing indicator is re-poked when the surface does not say. Telegram's own indicator
 *  expires after ~5 s and passes a shorter value; the rest are comfortable here. */
export const DEFAULT_TYPING_INTERVAL_MS = 8000;

const detailOf = (error) => String(error?.stack ?? error?.message ?? error);

/** Run one turn end to end.
 *
 *  @param run         `(onEvent) => Promise<reply>` — the adapter's brain call. Receives the event sink
 *                     this function builds; the empty-string reply means STEERED (see ./turnResult.mjs).
 *  @param stream      the surface's `LiveMessage`, or null when live rendering is off for this turn.
 *  @param ask         `{ post(event), resolve(event) }` — how a parked AskUserQuestion is shown and
 *                     retired when there is NO stream to do it. Null only for a turn that cannot park.
 *  @param typing      `{ poke(), stop?(), intervalMs? }`. `stop` is for a surface whose typing state
 *                     persists until cleared (WhatsApp presence); the others expire on their own.
 *  @param reactions   `{ seen, done, failed, add(value), remove?(value) }`, or null when this turn's
 *                     trigger must not be decorated — no triggering message at all (a slash-command turn
 *                     builds no message to react to), a private/targeted invocation where a public
 *                     reaction would leak that the exchange happened, or the operator turning them off.
 *                     `remove` is omitted by a surface where a new reaction REPLACES the previous one.
 *  @param send        `(reply) => Promise` — deliver the final answer when there is no stream.
 *  @param sendError   `(text) => Promise` — deliver the error text when the stream did not absorb it.
 *  @param errorText   `(error) => string` — the surface's user-facing error copy (`msg.error`).
 *  @param afterReply  optional `(reply) => Promise` — best-effort work that must happen after delivery
 *                     but before the completion marker (a spoken reply, a history record).
 *  @param log         `(detail) => void` — the operator's log sink for a failed turn.
 *  @returns the reply on success, `undefined` when the turn failed.
 */
export async function runTurn({
  run,
  stream = null,
  ask = null,
  typing,
  reactions = null,
  send,
  sendError,
  errorText,
  afterReply = null,
  log,
}) {
  // Named up front rather than at the point of use: a missing verb otherwise surfaces as an opaque
  // "x is not a function" halfway through a live turn, with the message already half-delivered.
  for (const [name, value] of [
    ['run', run], ['send', send], ['sendError', sendError],
    ['errorText', errorText], ['log', log], ['typing.poke', typing?.poke],
  ]) {
    if (typeof value !== 'function') throw new TypeError(`runTurn: ${name} must be a function`);
  }

  const onEvent = stream
    ? (e) => stream.onEvent(e)
    : (e) => {
      // Streaming OFF still has to render a parked question and retire it again. The turn is BLOCKED
      // inside AskUserQuestion until somebody answers it, so an adapter that forwards nothing here parks
      // the room until the core's timeout with no way to reply — and one that forwards only `ask` leaves
      // an expired question sitting there with live buttons forever. Both were real, on every platform.
      if (!ask) return;
      if (e.type === 'ask' && Array.isArray(e.questions)) void Promise.resolve(ask.post(e)).catch(() => {});
      else if (e.type === 'ask_resolved' && e.id) void Promise.resolve(ask.resolve(e)).catch(() => {});
    };

  const poke = () => { void Promise.resolve(typing.poke()).catch(() => {}); };
  poke();
  const typingTimer = setInterval(poke, typing.intervalMs ?? DEFAULT_TYPING_INTERVAL_MS);

  // The "seen" marker is fired without waiting — nothing should stall a turn on a status emoji — but the
  // terminal marker MUST wait for it. Removing or replacing a reaction whose write has not landed yet
  // leaves the eyes on the message for good, and every surface except Teams used to race exactly there.
  const marksSeen = reactions && reactions.seen !== undefined;
  const seenPending = marksSeen ? Promise.resolve(reactions.add(reactions.seen)).catch(() => {}) : null;

  /** Retire the "seen" marker and, when this turn earned one, add the terminal marker. */
  const settleReaction = async (terminal) => {
    if (!reactions) return;
    if (seenPending) await seenPending;
    if (marksSeen && reactions.remove) await Promise.resolve(reactions.remove(reactions.seen)).catch(() => {});
    if (terminal === undefined) return;
    void Promise.resolve(reactions.add(terminal)).catch(() => {});
  };

  try {
    const reply = await run(onEvent);
    if (stream) await stream.finalize(reply);
    else if (reply) await send(reply);
    if (reply && afterReply) {
      // Best-effort by contract: the answer has already gone out, so a failing extra must not swallow
      // the completion marker underneath it.
      await Promise.resolve(afterReply(reply)).catch((e) => log(detailOf(e)));
    }
    // A steered message was injected into a turn that was ALREADY running; it has no outcome of its own,
    // and the running turn's own message carries the eventual answer. A checkmark here would claim a
    // completion that has not happened yet.
    await settleReaction(isSteered(reply) ? undefined : reactions?.done);
    return reply;
  } catch (e) {
    // Logged as well as replied. This catch is what stops the webhook/gateway promise from rejecting, so
    // without this line an operator reads a perfectly healthy daemon log while every turn dies in chat.
    log(detailOf(e));
    const message = errorText(e);
    const handled = stream ? await stream.fail(message) : false;
    await settleReaction(reactions?.failed);
    if (!handled) await sendError(message).catch(() => {});
    return undefined;
  } finally {
    // In `finally`, not once per branch: the copies cleared the interval by hand in both, which means the
    // next early return anyone adds leaks a timer that pokes a dead conversation every few seconds.
    clearInterval(typingTimer);
    if (typing.stop) void Promise.resolve(typing.stop()).catch(() => {});
  }
}
