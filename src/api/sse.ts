import type { SignalSink, DerivedSignal } from '../deriver/types.js';
import type { PlanJobStatus } from '../overseer/planJob.js';
import type { Phase } from '../overseer/planner.js';
import { logger } from '../shared/logger.js';

const log = logger('sse');

export type OrcaEvent =
  | { type: 'signal'; session: string; signal: DerivedSignal }
  | { type: 'mission'; missionId: string; state: string }
  | { type: 'task'; taskId: string; status: string }
  | { type: 'plan'; jobId: string; status: PlanJobStatus; epicId?: string; phases?: Phase[]; error?: string };

export class EventBus implements SignalSink {
  private subs = new Set<(e: OrcaEvent) => void>();
  subscribe(fn: (e: OrcaEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  /** Isolate subscribers: a throwing/closed subscriber (e.g. a torn-down SSE stream) must not abort
   *  the broadcast to the rest — otherwise one dead client silences live events for everyone. */
  publish(e: OrcaEvent): void {
    for (const fn of this.subs) {
      try { fn(e); } catch (err) { log.error('event subscriber threw', err); }
    }
  }
  emit(session: string, signal: DerivedSignal): void { this.publish({ type: 'signal', session, signal }); }
}
