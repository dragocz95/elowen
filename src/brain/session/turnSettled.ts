import type { ClientOrigin } from '../../api/clientIp.js';
import type { BrainStore } from '../../store/brainStore.js';
import type { ConversationTitler } from '../conversationTitler.js';
import type { MemoryCurator } from '../memoryCurator.js';
import type { PinToken } from '../../store/usageOriginStore.js';
import { resetConversationActivity, type ConversationActivityChanged, type ConversationActivityStore, type ConversationActivitySurface } from './conversationActivity.js';

/** The ONE place that decides what a turn does BESIDES answering — the settlement side of the same
 *  discipline `composeTurnPrompt` applies to the prompt side.
 *
 *  It exists because these effects were implemented twice, or once and only for the owner. The owner
 *  chat curated memory in the turn runner and a room curated it again in the channel service; the owner
 *  titled a conversation from the model-facing text and a room titled it from the sender's words; the
 *  activity feed lived in the HTTP route, so every owner turn that did not arrive through
 *  `POST /brain/send` (a goal kickoff, a system nudge, a cron wake-up into an owner conversation) was
 *  invisible in it; the origin pin that attributes spend existed only on the HTTP side, so EVERY room
 *  turn settled as `internal` billed to the room's owner instead of the person who wrote it; the
 *  plugin-reload drain existed only for the owner, which is why `CreateSkill` issued from Discord wrote
 *  a skill to disk and then silently never applied it; and `last_writer_user_id` was written only by the
 *  platform orchestrator, so the conversation register showed an empty writer for every CLI and web row.
 *
 *  A surface that must NOT carry an effect OMITS ITS ARGUMENT instead of owning a second copy or an
 *  `if (surface === …)` branch. That is why `notify` has no channel counterpart: a room already received
 *  the answer in the room, so there is nobody to push it to.
 *
 *  Three entry points, because a turn genuinely has three moments and collapsing them would move an
 *  effect to the wrong one:
 *
 *  - {@link openTurn}             before the turn's first provider request
 *  - {@link titleTurnConversation} at admission, once the turn's user row exists
 *  - {@link settleTurn}           after the turn has settled
 *
 *  Two of them are paired, and the pairing is load-bearing rather than tidy: `openTurn` hands back an
 *  {@link OpenedTurn} that the surface must close on EVERY exit of the turn, and `settleTurn` belongs in a
 *  `finally`. A turn that throws is still a turn that happened — it may have written a skill to disk, and
 *  somebody did write in the room — and in a shared room a pin left behind by a turn that never ran bills
 *  the next colleague's turn to the previous writer.
 */

/** The write-time origin rollup, structurally — see `UsageOriginStore`. Attribution is accumulated as
 *  turns settle and is NEVER recovered by querying `brain_messages`, which carries no origin at all. */
export interface TurnOriginPin {
  recordRequest(sessionId: string, userId: number, origin: ClientOrigin, atMs: number): PinToken | null;
  releasePin(sessionId: string, token: PinToken): void;
  repointPin(fromSessionId: string, token: PinToken, toSessionId: string): void;
}

/** The team activity feed, structurally — the daemon supplies a bus-publishing callback. */
export type TurnActivityFeed = (e: { actorUserId: number | null; surface: string; target: string }) => void;

export interface TurnOpening {
  /** The conversation the turn is about to run in. */
  sessionId: string;
  /** Attribute this turn's spend to the account and address that ORDERED it, read now rather than at
   *  settle — by then the requester may be gone. Keyed on the WRITER: in a shared room the person typing
   *  is usually not the person who opened it, and billing the opener is how one account came to hold the
   *  largest bucket on the instance. Omitted where nothing ordered the turn (a goal continuation, a
   *  boot-recovered delegation), which settles honestly as `internal`. */
  origin?: { pin: TurnOriginPin; userId: number; origin: ClientOrigin; atMs: number };
  /** Report "someone is working, and from where" to the team feed. Emitted at the START of the turn, not
   *  at its end: the feed is streamed live to attached browsers, and a row that appears only once a long
   *  turn finishes reports history rather than activity. `target` is the feed's own subject — the channel
   *  key for a room, the conversation id for an owner turn — so it is stated rather than derived. */
  activity?: { record: TurnActivityFeed; actorUserId: number | null; surface: string; target: string };
  /** Durable owner-chat activity. Platform rooms deliberately omit this argument: their live presence is
   *  represented by the existing channel/session state, not by the owner conversation indicator. */
  conversationActivity?: {
    store: ConversationActivityStore;
    turnId: string;
    surface: ConversationActivitySurface;
    detail?: string;
    onChanged?: ConversationActivityChanged;
    /** Defer the durable working projection until the caller has acquired its conversation admission lock. */
    defer?: boolean;
  };
}

/** The opened turn's handle. A surface takes one from {@link openTurn} and MUST close it on every exit
 *  of the turn it opened, success or throw — which is why it is returned rather than optional. */
export interface OpenedTurn {
  /** Begin a deferred owner activity projection after the caller has acquired its admission lock. */
  begin(): void;
  /** The turn moved to another conversation mid-flight (owner-chat idle rollover archives the transcript
   *  and mints a fresh session id), so the pin follows it. Without this the turn settles under an id no
   *  pin was ever written for and records as `internal` against the row owner. */
  movedTo(sessionId: string): void;
  /** The turn is over. Releases a pin nothing consumed — a turn refused at shutdown, aborted before its
   *  first provider request, or rejected by any other pre-prompt guard. A pin that a settled turn already
   *  consumed, and a message steered into somebody else's running turn, both release nothing (the pin is
   *  token-keyed), so this is safe to call unconditionally and idempotent. */
  close(): void;
}

/** Everything that must happen before the turn's first provider request. */
export function openTurn(parts: TurnOpening): OpenedTurn {
  // The pin first: it is what the turn's spend will be attributed to, and the feed is best-effort
  // reporting. Neither can throw in practice, but the money side is never made to wait on the cosmetic one.
  const pin = parts.origin;
  let sessionId = parts.sessionId;
  let token = pin ? pin.pin.recordRequest(sessionId, pin.userId, pin.origin, pin.atMs) : null;
  const conversationActivity = parts.conversationActivity;
  let activitySessionId = sessionId;
  let activityStarted = false;
  const begin = (): void => {
    if (!conversationActivity || activityStarted) return;
    activityStarted = conversationActivity.store.beginSessionActivity(
      activitySessionId, conversationActivity.turnId, conversationActivity.surface, conversationActivity.detail);
    if (activityStarted) conversationActivity.onChanged?.(activitySessionId);
  };
  if (conversationActivity && !conversationActivity.defer) begin();
  if (parts.activity) {
    parts.activity.record({
      actorUserId: parts.activity.actorUserId,
      surface: parts.activity.surface,
      target: parts.activity.target,
    });
  }
  return {
    begin,
    movedTo(next: string): void {
      const previousSessionId = sessionId;
      if (pin && token != null) pin.pin.repointPin(sessionId, token, next);
      sessionId = next;
      if (!conversationActivity || activitySessionId === next) return;
      activitySessionId = next;
      if (!activityStarted) return;
      // Rollover creates a new row, so move the projection as two CAS-protected transitions: clear the
      // predecessor only when this turn still owns it, then begin on the replacement row.
      resetConversationActivity(conversationActivity.store, previousSessionId, conversationActivity.turnId, conversationActivity.onChanged);
      activityStarted = conversationActivity.store.beginSessionActivity(
        activitySessionId, conversationActivity.turnId, conversationActivity.surface, conversationActivity.detail);
      if (activityStarted) conversationActivity.onChanged?.(activitySessionId);
    },
    close(): void {
      if (!pin || token == null) return;
      pin.pin.releasePin(sessionId, token);
      token = null;
    },
  };
}

export interface TurnTitling {
  store: Pick<BrainStore, 'getSession' | 'setTitle'>;
  /** Replaces the provisional title with a model-written one in the background. Absent ⇒ the first 60
   *  characters stand, which is the whole title on a minimal wiring. */
  titler?: Pick<ConversationTitler, 'run'>;
  sessionId: string;
  /** The HUMAN's own words — never the model-facing text. The owner chat used to title from the composed
   *  turn text, so a conversation opened with an attachment or a prompt macro was named after the
   *  serialized form rather than the sentence the person typed. */
  senderText: string;
  /** Tell attached clients the background titler finished, with the title it landed. Required wherever a
   *  client renders the live conversation name: the titler runs on its own clock, so it routinely
   *  finishes after the turn settled — past the CLI's one-shot idle refresh — and a title that is only
   *  written to the store stays invisible until the next process restart. Omitted by surfaces with no
   *  live name on screen (a platform room), per this file's omission-over-branching rule. */
  announceTitle?: (title: string) => void;
}

/** Name a brand-new conversation from its first message. A no-op once the row has any title, so it is
 *  safe to call on every turn of every surface. */
export function titleTurnConversation(parts: TurnTitling): void {
  const senderText = parts.senderText.trim();
  if (!senderText) return;
  const row = parts.store.getSession(parts.sessionId);
  if (!row || row.title) return;
  const provisionalTitle = senderText.slice(0, 60);
  parts.store.setTitle(parts.sessionId, provisionalTitle);
  // Fire-and-forget by contract: ConversationTitler.run never rejects (see its own doc), so a turn is
  // never failed, delayed or rolled back by the naming of its conversation. It resolves with the title
  // it persisted — undefined when the provisional stands (unconfigured, error, manual rename won) —
  // and only a LANDED title is announced. Promise.resolve keeps the absent-titler case (and a bare
  // test double) on the same no-announce path.
  void Promise.resolve(parts.titler?.run(parts.sessionId, senderText, provisionalTitle))
    .then((title) => { if (title) parts.announceTitle?.(title); });
}

export interface TurnSettlement {
  sessionId: string;
  /** Distil durable facts from THIS exchange into the writer's memory. Omitted when the writer has no
   *  account, switched auto-save off, or the "turn" was a message steered into somebody else's running
   *  turn — that turn curates its own exchange, and curating the fragment again would store it twice. */
  curate?: { curator: Pick<MemoryCurator, 'run'>; userId: number; userText: string; assistantText: string };
  /** Record who last wrote here. Omitted for an unlinked sender: there is no account to name, and the
   *  register showing the room's owner instead would be a guess. */
  lastWriter?: { store: Pick<BrainStore, 'setLastWriter'>; userId: number };
  /** Apply a plugin reload a tool requested mid-turn (CreateSkill and friends). Omitted while another
   *  turn of this conversation is still running — the reload disposes live sessions, so it must never be
   *  drained under one. */
  drainPluginReload?: () => void;
  /** Owner-only, and expressed as an absent argument rather than a surface check: a room already
   *  received the answer where it was asked, so there is nothing to push to a phone. */
  notify?: () => void;
  /** Durable owner activity is settled here, alongside the other turn-owned effects. `idle` is reserved
   *  for an explicit user abort or interruption; it must not become an unread terminal failure. */
  conversationActivity?: {
    store: ConversationActivityStore;
    turnId: string;
    surface: ConversationActivitySurface;
    state: 'done' | 'failed' | 'idle';
    detail?: string;
    onChanged?: ConversationActivityChanged;
  };
}

/** Everything that happens once a turn has settled.
 *
 *  The order is load-bearing. The durable writer stamp goes down first, because it is the only effect
 *  here whose loss is not recoverable from anywhere else. The plugin reload goes LAST because it can
 *  dispose and respawn the very session the steps above read and write. */
export function settleTurn(parts: TurnSettlement): void {
  if (parts.conversationActivity) {
    const activity = parts.conversationActivity;
    if (activity.state === 'idle') {
      resetConversationActivity(activity.store, parts.sessionId, activity.turnId, activity.onChanged);
    } else {
      const changed = activity.store.settleSessionActivity(
        parts.sessionId, activity.turnId, activity.surface, activity.state, activity.detail);
      if (changed) activity.onChanged?.(parts.sessionId);
    }
  }
  if (parts.lastWriter) parts.lastWriter.store.setLastWriter(parts.sessionId, parts.lastWriter.userId);
  if (parts.curate) {
    // Never awaited and never allowed to fail a turn that has already produced its answer.
    void parts.curate.curator.run(parts.curate.userId, parts.curate.userText, parts.curate.assistantText)
      .catch(() => { /* the curator is best-effort */ });
  }
  parts.notify?.();
  parts.drainPluginReload?.();
}
