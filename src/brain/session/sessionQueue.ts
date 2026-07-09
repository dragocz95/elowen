import { randomUUID } from 'node:crypto';

/** One image attached to a queued message (base64 payload + mime type), carried through until the
 *  queued batch is delivered — never shipped to the UI snapshot. */
export interface QueuedImage { data: string; mimeType: string }

/** A message a user sent while a turn was already streaming. Instead of steering it into the running
 *  turn, it parks here and is delivered (combined with any siblings that share its mode) as ONE follow-up
 *  user message when the turn ends. `id` is server-minted so clients can remove a specific pending item.
 *  `text` is the model-facing prompt; `display` is what the chip and the delivered `you` echo show (the
 *  client's clean rendering, before @mention/prompt expansion). */
export interface QueuedMessage {
  id: string;
  userId: number;
  text: string;
  display: string;
  images?: QueuedImage[];
  mode: 'build' | 'plan';
  at: number;
}

/** What a client renders per pending item: the id (for removal) and the display text (for the chip).
 *  Images are intentionally omitted — the queue chip is a compact preview, not an attachment gallery. */
export interface QueueSnapshotItem { id: string; text: string }

/** The subset of the brain store the queue persists through — every SessionQueue mutation mirrors here so
 *  an accepted-but-undelivered message survives a daemon restart (see BrainStore.*Queued). */
export interface QueueStore {
  enqueueQueued(input: { id: string; sessionId: string; userId: number; text: string; display: string; images: string; mode: string; at: number }): void;
  listQueued(sessionId: string): { id: string; user_id: number; text: string; display: string; images: string; mode: string; at: number }[];
  removeQueued(sessionId: string, id: string): boolean;
  removeQueuedBatch(sessionId: string, ids: string[]): void;
  clearQueued(sessionId: string): void;
}

/** Per-send image cap — mirrors `brainSendSchema.images.max(4)` in src/api/schemas/brain.ts (the API
 *  bounds each message to this many images). Combining queued messages must never exceed it, so a drained
 *  batch is split into consecutive groups each carrying at most this many images (no image is ever dropped
 *  — see {@link firstBatchSize}). */
export const MAX_IMAGES_PER_TURN = 4;

/** Join the queued messages into ONE delivered prompt. Multiple messages are separated by a blank line
 *  so the model reads them as the user's consecutive messages; a single message passes through verbatim.
 *  Pure — shared by the flush path and unit-testable on its own. */
export function combineQueuedText(items: { text: string }[]): string {
  return items.map((m) => m.text).join('\n\n');
}

/** How many LEADING queued messages form the next deliverable batch: a maximal run that shares the first
 *  item's mode AND together carries at most `imageCap` images. Always ≥1 (a single message never exceeds
 *  the per-send image cap). Splitting on a mode change is a SAFETY rule — a plan-mode follow-up must never
 *  ride a build-mode batch's write tools; splitting on the image cap keeps every image delivered instead
 *  of silently truncated. Pure — exported for unit tests. */
export function firstBatchSize(items: QueuedMessage[], imageCap = MAX_IMAGES_PER_TURN): number {
  if (items.length === 0) return 0;
  const mode = items[0]!.mode;
  let images = items[0]!.images?.length ?? 0;
  let n = 1;
  for (; n < items.length; n++) {
    const it = items[n]!;
    if (it.mode !== mode) break;
    const add = it.images?.length ?? 0;
    if (images + add > imageCap) break;
    images += add;
  }
  return n;
}

/** Daemon-side per-session message queue — the SINGLE source of truth for messages sent mid-turn, shared
 *  by every client (CLI SSE, web SSE, later platforms) that follows the session. Keyed by sessionId so a
 *  second terminal / the web dock render and mutate the SAME live queue. DURABLE: every mutation mirrors
 *  into the brain store, so an accepted-but-undelivered message survives a daemon restart and is delivered
 *  on the next turn (a booting/reconnecting client re-seeds it from status()). Every mutation broadcasts a
 *  full-snapshot `queue` event to that session's listeners through the injected `emit`. */
export class SessionQueue {
  /** `emit(sessionId, items)` fans a full snapshot to that session's listeners (wired in BrainService to
   *  the live registry's listener set). Called after every mutation — the single emission point. */
  constructor(private store: QueueStore, private emit: (sessionId: string, items: QueueSnapshotItem[]) => void) {}

  /** The session's queued messages, image bytes parsed back out of the store (best-effort JSON). */
  private rows(sessionId: string): QueuedMessage[] {
    return this.store.listQueued(sessionId).map((r) => {
      let images: QueuedImage[] | undefined;
      try { const parsed = JSON.parse(r.images) as QueuedImage[]; if (Array.isArray(parsed) && parsed.length) images = parsed; }
      catch { /* corrupt row → treat as text-only rather than break the flush */ }
      return { id: r.id, userId: r.user_id, text: r.text, display: r.display, images, mode: r.mode === 'plan' ? 'plan' : 'build', at: r.at };
    });
  }

  private snapshot(sessionId: string): QueueSnapshotItem[] {
    return this.store.listQueued(sessionId).map((r) => ({ id: r.id, text: r.display }));
  }

  /** Append a message and broadcast the new snapshot. Returns the minted id. */
  enqueue(sessionId: string, msg: Omit<QueuedMessage, 'id'>): string {
    const id = randomUUID();
    this.store.enqueueQueued({
      id, sessionId, userId: msg.userId, text: msg.text, display: msg.display,
      images: JSON.stringify(msg.images ?? []), mode: msg.mode, at: msg.at,
    });
    this.emit(sessionId, this.snapshot(sessionId));
    return id;
  }

  /** The current snapshot (id + display text, in order) — seeds a booting/reconnecting client via
   *  status(), and re-surfaces durable rows after a restart. */
  list(sessionId: string): QueueSnapshotItem[] {
    return this.snapshot(sessionId);
  }

  /** Remove one pending message by id; broadcasts the reduced snapshot. Returns whether it matched
   *  (false for an unknown/already-delivered id — a tolerated no-op). */
  remove(sessionId: string, id: string): boolean {
    if (!this.store.removeQueued(sessionId, id)) return false;
    this.emit(sessionId, this.snapshot(sessionId));
    return true;
  }

  /** Take AND clear the NEXT deliverable batch (see {@link firstBatchSize}): the leading run of messages
   *  that share a mode and fit the image cap. Removes exactly those from the durable store, broadcasts the
   *  REMAINING snapshot, and returns the batch. Empty (and silent) when nothing is queued. The rest stay
   *  durable for the next flush pass — so a crash mid-flush loses nothing beyond the batch in flight. */
  drainBatch(sessionId: string, imageCap = MAX_IMAGES_PER_TURN): QueuedMessage[] {
    const all = this.rows(sessionId);
    if (all.length === 0) return [];
    const batch = all.slice(0, firstBatchSize(all, imageCap));
    this.store.removeQueuedBatch(sessionId, batch.map((m) => m.id));
    this.emit(sessionId, this.snapshot(sessionId));
    return batch;
  }

  /** Drop the whole queue for a session (abort / delete) — the user bailed, so pending messages die with
   *  the turn. Broadcasts the empty snapshot when there was anything to clear. */
  clear(sessionId: string): void {
    const had = this.store.listQueued(sessionId).length > 0;
    this.store.clearQueued(sessionId);
    if (had) this.emit(sessionId, []);
  }
}
