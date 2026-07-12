import type { BrainStore } from '../../store/brainStore.js';
import { projectUserTurn } from '../persistence.js';
import type { LiveBrain, QueuedMsg, QueuedImage, QueuedUserEcho } from './liveBrain.js';

/** Enqueue a mid-turn message into PI's native queue AND mirror it (text + image attachments) on the live
 *  session. Why the mirror: PI's public queue exposes only text (getSteeringMessages/getFollowUpMessages)
 *  and its clearQueue() drops image attachments (they live on the lower-level agent queue, not the text
 *  arrays). A positional queue-remove drains the queue and re-queues the survivors, so without an
 *  image-carrying copy every kept message would lose its image. `steer` interrupts the running turn;
 *  `followUp` waits for it. */
export async function enqueueMirrored(
  live: LiveBrain,
  kind: 'steer' | 'followUp',
  text: string,
  images?: QueuedImage[],
  echo?: QueuedUserEcho,
): Promise<void> {
  const arr = kind === 'steer' ? (live.queuedSteer ??= []) : (live.queuedFollowUp ??= []);
  const item: QueuedMsg = { text, images, ...(echo ? { echo } : {}) };
  arr.push(item);
  try {
    if (kind === 'steer') await live.session.steer(text, images);
    else await live.session.followUp(text, images);
  } catch (error) {
    // The mirror is speculative until PI accepts the message. A rejected steer must not survive as a
    // phantom queued item (or be re-persisted by queue-remove) when HTTP correctly reports no admission.
    const index = arr.indexOf(item);
    if (index >= 0) arr.splice(index, 1);
    throw error;
  }
}

/** Reconcile the image-carrying mirrors against PI's authoritative text queues after a `queue_update`.
 *  Matched by COUNT, not by text: PI expands skill commands / prompt templates before storing, so the
 *  stored text no longer equals what we enqueued. PI delivers FIFO and splices delivered messages off the
 *  FRONT, so a shrink drops mirror entries from the front; a grow (a path that enqueued straight through
 *  session.steer, bypassing enqueueMirrored — those never carry images) is padded at the END from PI's
 *  text, keeping counts aligned so positions match queueItems([...steering, ...followUp]). Mutates in
 *  place so the arrays shared with the LiveBrain stay the same references. */
export function reconcileMirrors(
  steerMirror: QueuedMsg[],
  followUpMirror: QueuedMsg[],
  steering: readonly string[],
  followUp: readonly string[],
): QueuedMsg[] {
  return [
    ...reconcileOne(steerMirror, steering),
    ...reconcileOne(followUpMirror, followUp),
  ];
}

function reconcileOne(mirror: QueuedMsg[], piTexts: readonly string[]): QueuedMsg[] {
  const removed = mirror.length > piTexts.length
    ? mirror.splice(0, mirror.length - piTexts.length) // FIFO delivery off the front
    : [];
  while (mirror.length < piTexts.length) mirror.push({ text: piTexts[mirror.length] ?? '' }); // enqueued outside the mirror → imageless
  // PI expands skill commands and prompt templates before storing them. Preserve the authoritative text
  // alongside our clean display/persistence metadata so message_start can match the exact delivered item.
  for (let index = 0; index < mirror.length; index += 1) mirror[index]!.queuedText = piTexts[index] ?? '';
  return removed;
}

/** Stage only echo-bearing queue entries that PI just removed immediately before user message_start. */
export function stageDeliveredUserEchoes(live: LiveBrain, removed: readonly QueuedMsg[]): void {
  const delivered = removed.filter((item) => item.echo);
  if (delivered.length) (live.deliveringUserEchoes ??= []).push(...delivered);
}

/** Explicit queue removal/abort is not delivery. Drop every transient delivery candidate it created. */
export function clearDeliveredUserEchoes(live: LiveBrain): void {
  live.deliveringUserEchoes = [];
}

/** Turn one PI-delivered queued user message into the durable transcript row and ordered replay marker.
 * Returns false for ordinary prompt message_start events and for explicitly removed queue entries. */
export function deliverQueuedUserEcho(store: BrainStore, live: LiveBrain, deliveredText: string): boolean {
  const pending = live.deliveringUserEchoes ?? [];
  const index = pending.findIndex((item) => item.queuedText === deliveredText && item.echo);
  if (index < 0) return false;
  const [item] = pending.splice(index, 1);
  const echo = item?.echo;
  if (!echo) return false;
  const durableId = projectUserTurn(store, live.sessionId, echo.persistText);
  const event = { type: 'user' as const, text: echo.displayText, durableId };
  if (echo.publish) live.replay.publish(event);
  else live.replay.journal(event);
  return true;
}
