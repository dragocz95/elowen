import type { BrainStore } from '../../store/brainStore.js';
import type { ConversationTitler } from '../conversationTitler.js';
import { projectUserTurn } from '../persistence.js';
import type { LiveBrain } from '../session/liveBrain.js';
import { enqueueMirrored } from '../session/queueMirror.js';
import type { TurnImage } from './turnRequest.js';

interface TurnAdmissionDeps {
  store: BrainStore;
  titler: ConversationTitler;
}

interface AdmissionInput {
  live: LiveBrain;
  text: string;
  images?: TurnImage[];
  display?: string;
  visible: boolean;
  titleOnAdmission: boolean;
  onAdmitted?: (sessionId: string) => void;
}

/** Owns the transaction boundary between hidden durable projection and PI acceptance. A row becomes
 * visible only after PI accepts it; every pre-admission failure rolls a visible user turn back. */
export class TurnAdmission {
  private durableId?: string;
  private persistText?: string;
  private admitted = false;
  private rolledBack = false;

  constructor(private d: TurnAdmissionDeps, private input: AdmissionInput) {}

  /** Project the clean durable row before PI preflight so native pre-prompt compaction can see it. */
  prepare(): { durableId: string; persistText: string } {
    if (this.durableId && this.persistText !== undefined) {
      return { durableId: this.durableId, persistText: this.persistText };
    }
    const marker = this.input.images?.length ? `\n[📎 ${this.input.images.length}× image]` : '';
    this.persistText = this.input.text + marker;
    this.durableId = projectUserTurn(this.d.store, this.input.live.sessionId, this.persistText);
    return { durableId: this.durableId, persistText: this.persistText };
  }

  /** PI native preflight callback. False is deliberately a no-op; prompt() throws and the caller rolls
   * the still-hidden projection back through rollbackPending(). */
  preflightResult = (success: boolean): void => {
    if (!success || !this.input.visible || this.admitted) return;
    this.publishAccepted();
  };

  /** Mid-turn admission uses PI steer instead of prompt preflight, but shares the same projection,
   * authoritative echo and rollback boundary. */
  async steer(): Promise<void> {
    this.prepare();
    try {
      await enqueueMirrored(
        this.input.live,
        'steer',
        this.input.text,
        this.input.images?.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
      );
      this.publishAccepted();
    } catch (error) {
      this.rollbackPending();
      throw error;
    }
  }

  /** Remove only a hidden user projection. Internal turns intentionally remain durable on failure,
   * matching the existing goal/system-turn history semantics. */
  rollbackPending(): void {
    if (!this.input.visible || this.admitted || this.rolledBack || !this.durableId) return;
    this.rolledBack = true;
    this.d.store.deleteMessage(this.input.live.sessionId, this.durableId);
  }

  private publishAccepted(): void {
    if (this.admitted) return;
    const { durableId, persistText } = this.prepare();
    const row = this.input.titleOnAdmission ? this.d.store.getSession(this.input.live.sessionId) : undefined;
    if (row && !row.title) {
      const provisionalTitle = this.input.text.slice(0, 60);
      this.d.store.setTitle(this.input.live.sessionId, provisionalTitle);
      void this.d.titler.run(this.input.live.sessionId, this.input.text, provisionalTitle);
    }
    this.input.live.replay.publish({
      type: 'user',
      text: this.input.display ?? persistText,
      durableId,
    });
    this.admitted = true;
    this.input.onAdmitted?.(this.input.live.sessionId);
  }
}
