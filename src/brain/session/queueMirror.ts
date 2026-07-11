import type { LiveBrain, QueuedMsg, QueuedImage } from './liveBrain.js';

/** Enqueue a mid-turn message into PI's native queue AND mirror it (text + image attachments) on the live
 *  session. Why the mirror: PI's public queue exposes only text (getSteeringMessages/getFollowUpMessages)
 *  and its clearQueue() drops image attachments (they live on the lower-level agent queue, not the text
 *  arrays). A positional queue-remove drains the queue and re-queues the survivors, so without an
 *  image-carrying copy every kept message would lose its image. `steer` interrupts the running turn;
 *  `followUp` waits for it. */
export async function enqueueMirrored(live: LiveBrain, kind: 'steer' | 'followUp', text: string, images?: QueuedImage[]): Promise<void> {
  const arr = kind === 'steer' ? (live.queuedSteer ??= []) : (live.queuedFollowUp ??= []);
  const item = { text, images };
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
export function reconcileMirrors(steerMirror: QueuedMsg[], followUpMirror: QueuedMsg[], steering: readonly string[], followUp: readonly string[]): void {
  reconcileOne(steerMirror, steering);
  reconcileOne(followUpMirror, followUp);
}

function reconcileOne(mirror: QueuedMsg[], piTexts: readonly string[]): void {
  if (mirror.length > piTexts.length) mirror.splice(0, mirror.length - piTexts.length); // FIFO delivery off the front
  while (mirror.length < piTexts.length) mirror.push({ text: piTexts[mirror.length] ?? '' }); // enqueued outside the mirror → imageless
}
