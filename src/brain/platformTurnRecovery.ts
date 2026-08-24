/** BOOT RESUME FOR ORDINARY PLATFORM CHANNEL TURNS (Discord rooms, DMs, …).
 *
 *  The durable foundation is the per-turn resume envelope (channels.ts, PlatformTurnResumeEnvelope):
 *  captured before the turn's first model call, deleted when the turn settles, so a surviving row names
 *  exactly the turn a process death interrupted. This module owns the decisions built on top of it:
 *
 *  - PARK ELIGIBILITY ({@link platformTurnParkEligible}): whether the step-boundary shutdown drain may
 *    park a live platform turn at all. A turn parks only where a faithful boot resume exists, so this is
 *    fail-closed on every fact the resume will need — a valid envelope, a verified account, an outbound
 *    delivery target, and never a scheduled/cron turn (their results have their own delivery contract and
 *    no one waiting in a room).
 *  - THE RESUME ({@link resumePlatformTurn}): continue ONE parked platform conversation from its own
 *    transcript tail and deliver the answer to the exact room or DM the interrupted turn came from.
 *  - THE RE-DELIVERY ({@link deliverPendingPlatformReply}): post an answer an EARLIER boot already
 *    computed but never managed to hand over.
 *
 *  THE OUTBOUND DELIVERY CONTRACT. A live turn replies through the adapter's `listen` callback return
 *  value, which dies with the process; a resumed turn cannot use it. It delivers through the orchestrator
 *  notification path instead — `PlatformAdapter.notify(text, channelId)` with an EXPLICIT conversation id,
 *  the documented "deliver to `channelId` when given" half of that contract, routed by the fail-closed
 *  `destination:` encoding (plugins/destinations.ts) so it can never broadcast. The target is the
 *  envelope's own `deliveryTarget` for a direct chat, and for a shared room it is derived from the
 *  registry channel key: the key is minted as `<platform>-<threadId ?? channelId>` (keyOf in platforms.ts,
 *  platform names never contain a hyphen — see platformOfSession), so the tail IS the platform's own send
 *  address for that room or thread. The reply is always posted as a FRESH message at the conversation's
 *  tail, never an edit of a pre-restart bubble: the adapters' conversation-order tracker
 *  (createConversationOrderTracker in elowen-plugin-shared) exists precisely because an in-place edit can
 *  land above messages that arrived later, and a fresh tail message cannot overtake anything by
 *  construction.
 *
 *  TWO DURABLE STATES, NEVER ONE. "The answer is computed" and "the answer is delivered" are separate
 *  facts, so they are separate durable states and the transition between them is a single transaction
 *  (BrainStore.promotePlatformTurnToDelivery):
 *
 *    envelope row + park marker  →  a turn that still needs a MODEL TURN   ({@link resumePlatformTurn})
 *    pending delivery row        →  an answer that only needs a POST       ({@link deliverPendingPlatformReply})
 *    neither                     →  nothing to do
 *
 *  Fusing the two — clearing everything before the post, as this module used to — meant an ordinary rate
 *  limit threw the answer away for good: the model turn was paid for, the reply sat in the durable
 *  transcript, and the room never heard anything. Splitting them collapses the objection that a retry
 *  costs a second model turn, because a retry RE-SENDS EXISTING TEXT. That is structural, not a
 *  convention: the promotion DELETES the envelope, so past it there are no prompt inputs left to run a
 *  model from, and {@link deliverPendingPlatformReply} is typed against {@link PlatformDeliveryDeps},
 *  which has no `send`.
 *
 *  THE AT-LEAST-ONCE CONSEQUENCE, deliberately accepted and BOUNDED. A post that actually landed but
 *  whose acknowledgement was lost will be sent a second time. In a chat a duplicate is visible and
 *  self-explaining while silence is not, so this is the lesser harm — but the attempts are capped like
 *  every other recovery kind's ({@link MAX_PLATFORM_DELIVERY_ATTEMPTS}), counted durably BEFORE each post
 *  so a boot that dies mid-post still counts it, and the give-up is loud in the log and posted into the
 *  conversation rather than silent. Duplicates are also the only failure this can produce: nothing past
 *  the promotion can produce a second, DIFFERENT answer. */
import { randomUUID } from 'node:crypto';
import type { PendingPlatformDelivery } from '../store/brainStore.js';
import type { Policy } from '../plugins/policy.js';
import type { ToolPolicy } from '../plugins/policyContext.js';
import { encodeNotificationDestination } from '../plugins/destinations.js';
import {
  normalizePlatformTurnEnvelope,
  provePlatformSenderBinding,
  resolvePlatformTurnAuthority,
  type ChannelSendOpts,
  type PlatformTurnResumeEnvelope,
} from './channels.js';
import type { RecoveryOutcome } from './recovery/types.js';
import { CRON_PLATFORM, channelSessionId, isChannelSession, isSubagentSession, platformOfSession } from './sessionId.js';

/** Boot resume attempts per park marker before the sweep gives up — the same cap (and the same durable
 *  claim-bump discipline) as owner conversations, delegations and workflows all use. */
export const MAX_PLATFORM_RESUME_ATTEMPTS = 3;

/** Outbound posts of ONE computed answer before the sweep gives up on delivering it. Its own counter
 *  rather than a share of the resume attempts above: those bound how often a MODEL TURN may be spent,
 *  these bound how often free text may be re-posted, and a turn that burned two model attempts before
 *  producing an answer must still get its three chances to deliver it. Same value (3), same
 *  bump-before-you-act discipline, same visible give-up. */
export const MAX_PLATFORM_DELIVERY_ATTEMPTS = 3;

/** The hidden continuation injected into a parked platform conversation — the channel twin of
 *  brainService's PARKED_RESUME_NOTE, delivered through the same custom-message seam (`internalSystem`)
 *  so it appends at the transcript's TAIL and never renders as a fake user bubble. */
const PLATFORM_RESUME_NOTE = 'The daemon restarted and interrupted this conversation\'s active turn at a step boundary. '
  + 'Every tool result above is complete, but the remaining work was not done and the final answer was never delivered. '
  + 'Continue exactly where the transcript leaves off and finish the turn: complete any remaining work and give the '
  + 'sender the answer they are still waiting for. Do not redo work whose results are already above, and do not dwell '
  + 'on the interruption. If the transcript shows the request was in fact fully answered, reply with a one-line '
  + 'confirmation only.';

/** Visible give-ups, posted into the affected conversation itself (best-effort — the log always carries
 *  the diagnosis). Formal on purpose: this is application copy read by whoever was waiting. */
const RESUME_GIVE_UP_NOTICE = 'A restart interrupted a reply in this conversation and it could not be resumed '
  + 'automatically. Please re-send the last message.';
const RESUME_REFUSED_NOTICE = 'A restart interrupted a reply in this conversation and it could not be resumed: '
  + 'the sender\'s account could no longer be verified. Please re-send the last message.';

/** The outbound target for a captured turn, or null when none can be named. Direct chats carry their own
 *  opaque target; a shared room's is derived from the registry key exactly as described in the module
 *  doc. Null (or an id the destination encoder refuses) fails the park/resume closed. */
export function resumeDeliveryTarget(envelope: PlatformTurnResumeEnvelope): string | null {
  if (envelope.deliveryTarget !== undefined) return envelope.deliveryTarget;
  const prefix = `${envelope.platform}-`;
  if (!envelope.channelId.startsWith(prefix)) return null;
  const id = envelope.channelId.slice(prefix.length);
  if (!id) return null;
  try { return encodeNotificationDestination(envelope.platform, id); } catch { return null; }
}

/** May the shutdown drain park THIS live platform channel turn? Consulted by the step-boundary hold (via
 *  the brainCore hook) at the moment it would park, when the current turn's envelope is already durable.
 *  Everything unproven is a NO — a parked turn nothing can resume means the person who asked simply never
 *  gets an answer, which is strictly worse than the drain waiting the turn out whole:
 *  - cron turns never park (their results ride the scheduler's own delivery contract, not a room);
 *  - a scheduled/unattended turn never parks for the same reason, whatever platform fired it;
 *  - an unlinked sender's turn never parks (the authority resolver would refuse it at boot anyway);
 *  - a turn carrying image attachments never parks: the bytes ride only the live prompt (they are never
 *    persisted), so a resumed model would see a text placeholder where the live turn saw the picture —
 *    and the rehydrated transcript would no longer be the cached prefix's bytes;
 *  - a turn with no nameable outbound target never parks (its answer could not be delivered). */
export function platformTurnParkEligible(
  store: { platformTurnEnvelope(sessionId: string): string | undefined },
  sessionId: string,
): boolean {
  if (!isChannelSession(sessionId) || isSubagentSession(sessionId)) return false;
  if (platformOfSession(sessionId) === CRON_PLATFORM) return false;
  const raw = store.platformTurnEnvelope(sessionId);
  if (!raw) return false;
  let envelope: PlatformTurnResumeEnvelope | null;
  try { envelope = normalizePlatformTurnEnvelope(JSON.parse(raw)); } catch { return false; }
  if (!envelope || channelSessionId(envelope.channelId) !== sessionId) return false;
  if (envelope.scheduled || envelope.accountUserId === null) return false;
  if (envelope.imageCount) return false;
  return resumeDeliveryTarget(envelope) !== null;
}

/** What POSTING a computed answer needs — and, just as importantly, what it does NOT: there is no `send`
 *  here, so {@link deliverPendingPlatformReply} cannot reach the model even by mistake. This is the
 *  structural half of "a delivery retry never re-runs the model"; the other half is that the promotion
 *  transaction has already deleted the envelope it would need. */
export interface PlatformDeliveryDeps {
  store: {
    pendingPlatformDelivery(sessionId: string): PendingPlatformDelivery | undefined;
    claimPlatformDeliveryAttempt(sessionId: string): boolean;
    clearPlatformTurnDelivery(sessionId: string): void;
  };
  /** Account existence check — a policy resolver alone does not prove the account still exists. */
  users: { get(userId: number): unknown | null | undefined };
  /** Re-proves the platform sender → account binding (the daemon's live link resolver). null = the
   *  identity is no longer linked; wired fail-closed, so a wiring without a resolver refuses resumes. */
  resolvePlatformUser: (platform: string, platformUserId: string) => { id: number } | null;
  /** Whether the outbound path could reach this target right now (PlatformOrchestrator.canDeliver):
   *  the platform is installed, connected and exposes a notification sink. Asked BEFORE the model turn,
   *  so an uninstalled plugin or a revoked bot fails closed without spending a turn. */
  canDeliver(target: string): boolean;
  /** Post one fresh message to the encoded destination (PlatformOrchestrator.notify). Throws on failure. */
  deliver(text: string, target: string): Promise<void>;
  log: { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
}

/** What the full resume needs from the brain — the delivery seam above plus everything it takes to
 *  COMPUTE an answer. Narrow on purpose, mirroring BootRecoveryHost: BrainService wires its own store,
 *  channel service and platform orchestrator in; a test satisfies it with the same fakes the channel
 *  suites use. */
export interface PlatformTurnRecoveryDeps extends PlatformDeliveryDeps {
  store: PlatformDeliveryDeps['store'] & {
    platformTurnEnvelope(sessionId: string): string | undefined;
    clearPlatformTurnEnvelope(sessionId: string): void;
    clearSessionPark(sessionId: string): void;
    claimParkResumeAttempt(sessionId: string): boolean;
    /** Returns the row as it landed durably — the caller posts from THAT, never from its own input. */
    promotePlatformTurnToDelivery(sessionId: string, delivery: {
      reply: string; target: string; platform: string; platformUserId: string; accountUserId: number;
    }): PendingPlatformDelivery;
  };
  policyForUser?: (userId: number) => Policy;
  /** The account's current tool authority. Required for the same reason it is required on
   *  {@link PlatformTurnAuthorityDeps}: an absent grant reads as unrestricted, so making this optional
   *  would turn a wiring mistake into a silent privilege escalation on the resume path. */
  toolAuthorityFor: (userId: number) => ToolPolicy | undefined;
  /** The ordinary channel turn pipeline (ChannelSessionService.send) — the resume is one more send. */
  send(opts: ChannelSendOpts, text: string): Promise<string>;
}

/** A best-effort user-facing notice into the affected conversation itself; the log is the durable record.
 *  Never throws — a give-up must not become a second failure. */
async function postNotice(deps: PlatformDeliveryDeps, sessionId: string, target: string, text: string): Promise<void> {
  if (!deps.canDeliver(target)) return;
  await deps.deliver(text, target).catch((e) => deps.log.error(`parked platform turn ${sessionId}: notice delivery failed`, e));
}

/** POST one already-computed answer. The whole point of the second durable state: this spends no model
 *  turn — it cannot, its deps have no `send` and the promotion already deleted the envelope — so it is
 *  free to retry until the cap.
 *
 *  The authority the answer was computed under is RE-PROVEN here, not inherited: a sender who unlinked,
 *  or a platform id that was claimed by a different account, while the daemon was down must not receive
 *  the old account's answer, and a retry must not be a back door around the check the model path makes.
 *  That refusal is terminal — no later boot can conjure the binding back. */
export async function deliverPendingPlatformReply(
  deps: PlatformDeliveryDeps,
  pending: PendingPlatformDelivery,
): Promise<RecoveryOutcome> {
  const { log } = deps;
  const { sessionId, target } = pending;
  if (pending.attempts >= MAX_PLATFORM_DELIVERY_ATTEMPTS) {
    // Visible give-up rather than an answer that quietly rots in the table forever: the row goes, the log
    // carries the diagnosis, and the conversation itself is told it needs a re-send.
    deps.store.clearPlatformTurnDelivery(sessionId);
    log.error(`parked platform turn ${sessionId}: the computed answer could not be delivered in `
      + `${MAX_PLATFORM_DELIVERY_ATTEMPTS} attempts — giving up; the sender must re-send`);
    await postNotice(deps, sessionId, target, RESUME_GIVE_UP_NOTICE);
    return 'terminalized';
  }
  try {
    provePlatformSenderBinding(pending, deps.resolvePlatformUser);
    if (!deps.users.get(pending.accountUserId)) {
      throw new Error(`account ${pending.accountUserId} no longer exists`);
    }
  } catch (e) {
    deps.store.clearPlatformTurnDelivery(sessionId);
    log.error(`parked platform turn ${sessionId}: authority refused — the computed answer will not be delivered`, e);
    await postNotice(deps, sessionId, target, RESUME_REFUSED_NOTICE);
    return 'terminalized';
  }
  // The durable claim, taken BEFORE the post so a boot that dies mid-post still counts the attempt and
  // the retry stays bounded. A false return means the row was cleared since the worklist was read — the
  // answer is already out — and posting now would be the duplicate this counter exists to bound.
  if (!deps.store.claimPlatformDeliveryAttempt(sessionId)) {
    log.info(`parked platform turn ${sessionId}: the computed answer was delivered before this attempt reached it — skipping`);
    return 'released';
  }
  // Unavailability counts as a spent attempt like any other failed post: an uninstalled plugin or a
  // revoked bot would otherwise keep this row alive across every future boot with nothing to show.
  if (!deps.canDeliver(target)) {
    log.error(`parked platform turn ${sessionId}: platform "${pending.platform}" is unavailable — the computed answer `
      + `is still undelivered (attempt ${pending.attempts + 1}/${MAX_PLATFORM_DELIVERY_ATTEMPTS})`);
    return 'failed';
  }
  try {
    await deps.deliver(pending.reply, target);
  } catch (e) {
    log.error(`parked platform turn ${sessionId}: delivering the computed answer to "${pending.platform}" failed `
      + `(attempt ${pending.attempts + 1}/${MAX_PLATFORM_DELIVERY_ATTEMPTS}); it stays pending for the next boot`, e);
    // NOT 'resumed': the answer exists but nobody in that room has it, and the boot summary must not be
    // the one place that gap is invisible.
    return 'failed';
  }
  // Confirmed post — and only a confirmed post — retires the answer.
  deps.store.clearPlatformTurnDelivery(sessionId);
  log.info(`parked platform turn ${sessionId}: delivered the computed answer (attempt ${pending.attempts + 1})`);
  return 'resumed';
}

/** One item of the `platform-conversations` provider's worklist. A parked session row satisfies it as it
 *  stands; a pending delivery is claimed as one too (its `park_attempts` is meaningless — a delivery
 *  counts its own attempts on its own row). Deliberately narrower than BrainSessionRow: nothing in this
 *  module may reach for session columns it has not proven are still true. */
export interface ParkedPlatformTurn {
  id: string;
  park_attempts: number;
}

/** `platform-conversations` provider, RESUME: continue ONE parked platform channel turn from its own
 *  transcript tail, then deliver the answer to the exact conversation it came from. Every refusal below
 *  clears the marker (terminal — nothing will retry what cannot ever succeed) while a FAILED resume turn
 *  keeps it (the attempt is durably counted, so the next boot retries up to the cap). */
export async function resumePlatformTurn(
  deps: PlatformTurnRecoveryDeps,
  row: ParkedPlatformTurn,
): Promise<RecoveryOutcome> {
  const { log } = deps;
  // FIRST, before any envelope parsing or invariant check: a computed answer outranks everything else
  // here, and this branch needs nothing but its own row. Asking later would let one of the fail-closed
  // envelope refusals below read an answer that already exists as "nothing to do" and drop it.
  const pending = deps.store.pendingPlatformDelivery(row.id);
  if (pending) return deliverPendingPlatformReply(deps, pending);
  // Terminal stand-down: forget both durable halves of the interrupted turn.
  const terminalize = (): void => {
    deps.store.clearSessionPark(row.id);
    deps.store.clearPlatformTurnEnvelope(row.id);
  };
  // Fail closed on anything the park invariant says cannot happen: only ordinary platform channel
  // sessions ever reach this provider (owner conversations have their own; sub-agents leave no marker).
  if (!isChannelSession(row.id) || isSubagentSession(row.id)) {
    log.warn(`park marker on non-platform session ${row.id} — invariant breach; clearing without resume`);
    deps.store.clearSessionPark(row.id);
    return 'released';
  }
  const raw = deps.store.platformTurnEnvelope(row.id);
  let envelope: PlatformTurnResumeEnvelope | null = null;
  try { envelope = raw ? normalizePlatformTurnEnvelope(JSON.parse(raw)) : null; } catch { envelope = null; }
  if (!envelope || channelSessionId(envelope.channelId) !== row.id) {
    log.warn(`parked platform turn ${row.id}: no valid resume envelope; clearing without resume`);
    terminalize();
    return 'terminalized';
  }
  if (envelope.scheduled || platformOfSession(row.id) === CRON_PLATFORM) {
    log.warn(`parked platform turn ${row.id}: scheduled/cron turns have no boot resume — invariant breach; clearing`);
    terminalize();
    return 'released';
  }
  const target = resumeDeliveryTarget(envelope);
  if (!target) {
    log.warn(`parked platform turn ${row.id}: no outbound delivery target can be named; clearing without resume`);
    terminalize();
    return 'terminalized';
  }
  const notice = (text: string): Promise<void> => postNotice(deps, row.id, target, text);
  // Deleted platform plugin, revoked bot, adapter that failed to connect: nothing this boot could deliver
  // to, and nothing a retry under the same conditions would fix — fail closed and stand down.
  if (!deps.canDeliver(target)) {
    log.error(`parked platform turn ${row.id}: platform "${envelope.platform}" is unavailable for delivery — giving up; the sender must re-send`);
    terminalize();
    return 'terminalized';
  }
  // The park gate refuses image-bearing turns, but an envelope is durable data from an earlier build —
  // re-check here. The bytes were never persisted, so the durable transcript cannot reproduce what the
  // live turn saw; resuming would answer about a picture the model can no longer see.
  if (envelope.imageCount) {
    terminalize();
    log.error(`parked platform turn ${row.id}: the interrupted turn carried ${envelope.imageCount} image(s) the durable transcript cannot reproduce — giving up; the sender must re-send`);
    await notice(RESUME_GIVE_UP_NOTICE);
    return 'terminalized';
  }
  if (row.park_attempts >= MAX_PLATFORM_RESUME_ATTEMPTS) {
    // Visible give-up: the marker goes (no further stacking), the log carries the diagnosis, and the
    // conversation itself is told it needs a re-send — the same shape the owner sweep pushes to a phone.
    terminalize();
    log.error(`parked platform turn ${row.id} exhausted ${MAX_PLATFORM_RESUME_ATTEMPTS} boot resume attempts — giving up; the sender must re-send`);
    await notice(RESUME_GIVE_UP_NOTICE);
    return 'terminalized';
  }
  // WHO the resumed turn runs as is re-derived from the ACCOUNT, never replayed: an account that was
  // deleted or unlinked since the park refuses the resume outright — no operator fallback, no ambient
  // policy — and the refusal is terminal (retrying cannot conjure the account back).
  let authority: ReturnType<typeof resolvePlatformTurnAuthority>;
  try {
    authority = resolvePlatformTurnAuthority(envelope, {
      resolvePlatformUser: deps.resolvePlatformUser,
      policyForUser: (userId) => (deps.users.get(userId) ? deps.policyForUser?.(userId) : undefined),
      toolAuthorityFor: deps.toolAuthorityFor,
    });
  } catch (e) {
    terminalize();
    log.error(`parked platform turn ${row.id}: authority refused — not resuming`, e);
    await notice(RESUME_REFUSED_NOTICE);
    return 'terminalized';
  }
  // The durable claim: bump the attempt counter, but only while the marker still stands. Losing this race
  // means the room already spoke (channel turn admission clears the marker) — their message is the
  // continuation then, and injecting ours on top is exactly the double-continuation this guards against.
  if (!deps.store.claimParkResumeAttempt(row.id)) {
    log.info(`parked platform turn ${row.id}: marker cleared before the sweep reached it (the room spoke) — skipping resume`);
    return 'released';
  }
  let reply: string;
  try {
    reply = await deps.send({
      channelId: envelope.channelId,
      ownerUserId: envelope.ownerUserId,
      direct: envelope.direct,
      policy: authority.policy,
      // Prompt inputs replay VERBATIM (byte-stability); authority does not: the room-role facts storage
      // cannot re-verify — the trusted-channel elevation and the identity's admin/owner flags — are
      // clamped, the exact rule resolvePlatformTurnAuthority applies to the policy itself.
      ...(envelope.promptAppend?.length ? { promptAppend: [...envelope.promptAppend] } : {}),
      trusted: false,
      scheduled: false,
      ...(envelope.model ? { model: envelope.model } : {}),
      ...(envelope.thinkingLevel !== undefined ? { thinkingLevel: envelope.thinkingLevel } : {}),
      ...(envelope.fast !== undefined ? { fast: envelope.fast } : {}),
      // A resume CONTINUES the interrupted transcript by definition; the idle-rollover check would see
      // the pre-restart quiet time and archive the very conversation the continuation needs.
      idleRolloverMs: Infinity,
      ...(authority.toolPolicy ? { toolPolicy: authority.toolPolicy } : {}),
      identity: { ...envelope.identity, admin: false, owner: false },
      writerUserId: authority.accountUserId,
      ...(envelope.deliveryTarget !== undefined ? { deliveryTarget: envelope.deliveryTarget } : {}),
      // The same custom-system continuation shape the owner sweep uses: appends at the transcript's
      // TAIL, never a fake user row, never a history rewrite — and send() verifies the triggered turn
      // produced a fresh, normally settled assistant before returning.
      internalSystem: { customType: 'restart-resume', resultId: `restart-resume-${randomUUID()}` },
    }, PLATFORM_RESUME_NOTE);
  } catch (e) {
    // Marker deliberately kept: the attempt is durably counted, so the next boot retries up to the cap.
    log.error(`boot resume failed for parked platform turn ${row.id} (attempt ${row.park_attempts + 1}/${MAX_PLATFORM_RESUME_ATTEMPTS}); marker kept for the next boot`, e);
    return 'failed';
  }
  if (!reply.trim()) {
    terminalize();
    log.error(`parked platform turn ${row.id}: the resume turn settled with an empty reply — nothing to deliver`);
    return 'terminalized';
  }
  // THE PROMOTION, in ONE transaction and strictly BEFORE the post: the marker and the envelope go, and
  // the computed answer becomes durably deliverable in their place. Past this line the model can never
  // run for this turn again — the prompt inputs it would need no longer exist — and the answer can no
  // longer be lost by a failed post, because only a confirmed post clears it.
  const promoted = deps.store.promotePlatformTurnToDelivery(row.id, {
    reply,
    target,
    // The IDENTITY's platform, i.e. exactly what the binding proof is keyed on — not `envelope.platform`,
    // which is the orchestrator's routing name.
    platform: envelope.identity.platform,
    platformUserId: envelope.identity.userId,
    accountUserId: authority.accountUserId,
  });
  log.info(`boot resume finished parked platform turn ${row.id} (attempt ${row.park_attempts + 1}); delivering the answer`);
  // The first post is just the first delivery attempt: same counter, same cap, same code as every retry.
  return deliverPendingPlatformReply(deps, promoted);
}
