import type { BrainStore } from '../../store/brainStore.js';
import type { ConversationTitler } from '../conversationTitler.js';
import { attachmentMarker, storeChatImages, toMessageImages, type StoredChatImage } from '../chatImages.js';
import { projectUserTurn } from '../persistence.js';
import type { LiveBrain } from '../session/liveBrain.js';
import { enqueueMirrored } from '../session/queueMirror.js';
import type { TurnImage, TurnMode } from './turnRequest.js';

interface TurnAdmissionDeps {
  store: BrainStore;
  titler: ConversationTitler;
  /** Where a turn's attachments are written so they outlive it. Absent (in-memory store, tests) → the
   *  message keeps only its `[📎 N× image]` marker, exactly as before. */
  chatImagesDir?: string;
}

interface AdmissionInput {
  live: LiveBrain;
  text: string;
  persistText?: string;
  images?: TurnImage[];
  display?: string;
  mode?: TurnMode;
  visible: boolean;
  titleOnAdmission: boolean;
  onAdmitted?: (sessionId: string) => void;
}

/** Owns the transaction boundary between hidden durable projection and PI acceptance. A row becomes
 * visible only after PI accepts it; every pre-admission failure rolls a visible user turn back. */
export class TurnAdmission {
  private durableId?: string;
  private persistText?: string;
  private stored: StoredChatImage[] = [];
  private admitted = false;
  private echoed = false;
  private rolledBack = false;

  constructor(private d: TurnAdmissionDeps, private input: AdmissionInput) {}

  /** Project the clean durable row before PI preflight so native pre-prompt compaction can see it. */
  prepare(): { durableId: string; persistText: string } {
    if (this.durableId && this.persistText !== undefined) {
      return { durableId: this.durableId, persistText: this.persistText };
    }
    this.persistText = this.durableText();
    this.stored = this.storeImages();
    this.durableId = projectUserTurn(this.d.store, this.input.live.sessionId, this.persistText, this.stored);
    return { durableId: this.durableId, persistText: this.persistText };
  }

  /** Write the attachments once per admission. The base64 is in memory only for this turn, so this is the
   *  single moment it can be captured; the result is reused by both the durable row and the live echo. */
  private storeImages(): StoredChatImage[] {
    if (!this.d.chatImagesDir || !this.input.images?.length) return [];
    return storeChatImages(this.d.chatImagesDir, this.input.images);
  }

  /** Publish the authoritative `user` event — the ONLY thing clients render the sent bubble from (none of
   * them pushes an optimistic echo of its own). Callable, and called, BEFORE the turn context is built:
   * that build awaits turn-start memory recall, which is a remote embedding request with a 30 s deadline,
   * and a sent message must not stay invisible for it. The turn itself still waits for the memories.
   *
   * ADMISSION deliberately does not move with it — it stays on PI's preflight, because it gates the HTTP
   * 202 and that timing is what closes the 202 → isStreaming=false window an immediate follow-up would
   * otherwise slip through. So is `lastAdmitted`: an Esc has a turn to discard only once PI holds one.
   * A turn rejected between this echo and preflight retracts the bubble in rollbackPending(). */
  echo(): void {
    if (!this.input.visible || this.echoed) return;
    const { durableId } = this.prepare();
    // Reset before the event goes out, so a cancel racing the turn's first token reads a consistent
    // `turnProducedOutput`.
    this.input.live.turnProducedOutput = false;
    this.input.live.replay.publish({
      type: 'user',
      text: this.displayText(),
      durableId,
      ...(this.stored.length ? { images: toMessageImages(this.stored) } : {}),
    });
    this.echoed = true;
  }

  /** PI native preflight callback. False is deliberately a no-op; prompt() throws and the caller rolls
   * the unadmitted projection back through rollbackPending(). */
  preflightResult = (success: boolean): void => {
    if (!success || !this.input.visible || this.admitted) return;
    this.publishAccepted();
  };

  /** Mid-turn admission ends when PI accepts the queue entry, but acceptance is NOT delivery. Keep its
   * durable/display identity on the mirrored queue item; the spawner projects and echoes it only when PI
   * removes that item and emits the matching user message_start. */
  async steer(): Promise<void> {
    const persistText = this.durableText();
    // Store the attachments HERE, not at delivery: the base64 only exists while the message waits in PI's
    // transient queue, and the durable row is written later, by deliverQueuedUserEcho. A queue entry that
    // never gets delivered leaves the files unreferenced, which the daily sweep reclaims.
    this.stored = this.storeImages();
    await enqueueMirrored(
      this.input.live,
      'steer',
      this.input.text,
      this.input.images?.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
      {
        persistText,
        displayText: this.input.display ?? this.input.persistText ?? this.input.text,
        ...(this.stored.length ? { images: this.stored } : {}),
        // The clean model-facing text before the running-subagents block and the attachment marker: what a
        // later Esc-promotion re-composes from (`input.text` still carries the block; `persistText` the marker).
        sourceText: this.input.persistText ?? this.input.text,
        mode: this.input.mode,
        publish: true,
      },
    );
    this.markAdmitted();
  }

  /** Undo an unadmitted user turn: delete its durable row and retract its echo. Internal turns
   * intentionally remain durable on failure, matching the existing goal/system-turn history semantics. */
  rollbackPending(): void {
    if (!this.input.visible || this.admitted || this.rolledBack || !this.durableId) return;
    this.rolledBack = true;
    this.d.store.deleteMessage(this.input.live.sessionId, this.durableId);
    // The echo now precedes the turn context, so a turn rejected in between has a bubble on screen with
    // no row behind it. Retract it through the same event Esc-before-output uses: clients pop the trailing
    // 'you' turn and the CLI puts the text back into an empty composer.
    if (this.echoed) {
      this.input.live.replay.publish({ type: 'discard_user', durableId: this.durableId, text: this.displayText() });
    }
  }

  private publishAccepted(): void {
    if (this.admitted) return;
    const { durableId } = this.prepare();
    const row = this.input.titleOnAdmission ? this.d.store.getSession(this.input.live.sessionId) : undefined;
    if (row && !row.title) {
      const provisionalTitle = this.input.text.slice(0, 60);
      this.d.store.setTitle(this.input.live.sessionId, provisionalTitle);
      void this.d.titler.run(this.input.live.sessionId, this.input.text, provisionalTitle);
    }
    this.echo();
    // Arm the Esc/Stop-before-output discard for THIS turn: remember the row a discard would delete + the
    // text it would restore (the same text shown in the bubble).
    this.input.live.lastAdmitted = { durableId, text: this.displayText() };
    this.markAdmitted();
  }

  /** The text the bubble shows — and the text a discard restores to the composer. */
  private displayText(): string {
    return this.input.display ?? this.prepare().persistText;
  }

  private durableText(): string {
    const marker = this.input.images?.length ? attachmentMarker(this.input.images.length) : '';
    return (this.input.persistText ?? this.input.text) + marker;
  }

  private markAdmitted(): void {
    if (this.admitted) return;
    this.admitted = true;
    this.input.onAdmitted?.(this.input.live.sessionId);
  }
}
