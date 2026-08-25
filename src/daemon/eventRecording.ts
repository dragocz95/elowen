import { eventProjectId } from '../api/eventProject.js';
import type { EventBus } from '../api/sse.js';
import type { EventStore } from '../store/eventStore.js';

interface EventRecordingDeps {
  bus: EventBus;
  events: EventStore;
  log: { error: (m: string, e?: unknown) => void };
}

/** Install activity-log persistence. Plugin events carry their project tenancy directly. */
export function installEventRecording(deps: EventRecordingDeps): void {
  deps.bus.subscribe((e) => {
    try { deps.events.record(e, eventProjectId(e)); }
    catch (err) { deps.log.error('event record failed', err); }
  });
}
