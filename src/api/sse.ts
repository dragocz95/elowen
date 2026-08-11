import type { SignalSink, DerivedSignal } from '../deriver/types.js';
import type { PlanJobStatus } from '../overseer/planJob.js';
import type { Phase } from '../overseer/planner.js';
import { logger } from '../shared/logger.js';

const log = logger('sse');

export type ElowenEvent =
  | { type: 'signal'; session: string; signal: DerivedSignal }
  | { type: 'mission'; missionId: string; state: string }
  | { type: 'task'; taskId: string; status: string }
  | { type: 'review'; missionId: string; taskId: string; approve: boolean; rationale: string }
  | { type: 'decision'; taskId: string; kind: 'prompt' | 'choice'; question: string; outcome: 'approved' | 'escalated' | 'chose'; rationale: string; confidence: number; optionLabel?: string }
  // A free-text turn in the worker↔autopilot conversation on a task (`elowen ask`): the agent's question
  // or the reply (overseer/human/sentinel). Persisted on the task so the detail pane renders the thread.
  | { type: 'message'; taskId: string; role: 'agent' | 'autopilot' | 'human'; text: string }
  // A transient nudge that a task's pending-ask state changed (escalated to a human, or answered) so the
  // Escalations inbox refetches. Not persisted — the `message` turns are the durable record.
  | { type: 'ask'; taskId: string }
  | { type: 'change'; taskId: string }
  // A recall delivered memories to the model, so their usage counters and vitality just moved. Carries no
  // memory content and no ids — only whose view is now stale. The /events gate gives it to that user alone.
  | { type: 'memory'; userId: number }
  | { type: 'plan'; jobId: string; status: PlanJobStatus; epicId?: string; phases?: Phase[]; error?: string }
  // A plugin-originated event (plugin platform). `projectId` IS the tenancy: subscribers scoped to
  // projects receive it only when it names one of theirs, and null reaches admins alone (fail closed —
  // see eventProject.ts). `plugin` is stamped by the host from the publishing plugin's own name.
  | { type: 'plugin'; plugin: string; kind: string; projectId: number | null; data: unknown };

export class EventBus implements SignalSink {
  private subs = new Set<(e: ElowenEvent) => void>();
  subscribe(fn: (e: ElowenEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  /** Isolate subscribers: a throwing/closed subscriber (e.g. a torn-down SSE stream) must not abort
   *  the broadcast to the rest — otherwise one dead client silences live events for everyone. */
  publish(e: ElowenEvent): void {
    for (const fn of this.subs) {
      try { fn(e); } catch (err) { log.error('event subscriber threw', err); }
    }
  }
  emit(session: string, signal: DerivedSignal): void { this.publish({ type: 'signal', session, signal }); }
}
