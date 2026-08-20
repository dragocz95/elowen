import { eventProjectId, type EventProjectDeps } from '../api/eventProject.js';
import type { EventBus } from '../api/sse.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { EventStore } from '../store/eventStore.js';
import type { TaskRefs } from '../store/taskRefs.js';

interface EventRecordingDeps {
  taskRefs: TaskRefs;
  loadedPlugins: () => PluginRegistry | undefined;
  bus: EventBus;
  events: EventStore;
  log: { error: (m: string, e?: unknown) => void };
}

/** Install activity-log persistence and return the same live resolver getter used by HTTP tenancy. */
export function installEventRecording(deps: EventRecordingDeps): NonNullable<EventProjectDeps['pluginResolvers']> {
  // Persist every bus event into the activity log, stamping its owning project (resolved for ALL event
  // types, not just task/review) so the timeline can be scoped per-tenant. The event store is
  // core-owned; it keeps recording plugin-published events through the shared bus unchanged.
  // `signal`/`plan` tenancy (session→task via the agent:<name> label, plan job → its runtime record)
  // deliberately has NO core lookup here: the agents plugin's registered event resolver is the sole
  // source — with the plugin disabled those events resolve null and the rows record admin-only,
  // matching the rest of the disabled-plugin degradation.
  // Live registry read (not a snapshot): a plugin reload swaps the resolver set with it. Shared by
  // the recorder below AND the server deps (eventProjectResolvers), so the SSE per-subscriber gate
  // and the persisted activity rows scope events through the exact same resolvers.
  const pluginEventResolvers = () => (deps.loadedPlugins()?.eventProjectResolvers ?? []).map((r) => r.fn);
  const eventDeps: EventProjectDeps = {
    taskProject: (id) => deps.taskRefs.get(id)?.project_id ?? null,
    pluginResolvers: pluginEventResolvers,
  };
  deps.bus.subscribe((e) => {
    try { deps.events.record(e, eventProjectId(e, eventDeps)); }
    catch (err) { deps.log.error('event record failed', err); }
  });
  return pluginEventResolvers;
}
