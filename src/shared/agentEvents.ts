/** Event-contract types shared between the core bus/SSE surface and the agents subsystem.
 *
 *  These shapes ride ElowenEvent (`signal`, `plan`) and are read by every SSE consumer — web, event
 *  store, CLI — so they belong to the CORE contract, not to the code that produces them: the producers
 *  (deriver, overseer plan jobs) move into the agents plugin with the extraction, while consumers must
 *  keep decoding the same bytes. Moving the definitions here breaks the api/sse.ts → deriver/overseer
 *  type cycle that would otherwise drag the whole subsystem back into the core module graph. */

/** What the deriver concluded about a live agent session from its pane output. */
export type DerivedSignal =
  | { type: 'working' }
  | { type: 'complete' }
  | { type: 'needs_input'; question: string; options: { id: string; label: string }[]; context: string };

export interface SignalSink { emit(session: string, s: DerivedSignal): void }

export type PlanJobStatus = 'planning' | 'done' | 'failed';

/** One planned phase of an epic, as the planner model emits it. */
export interface Phase {
  title: string; type: string; agent?: string; details?: string; exec?: string;
  /** Planner-local slug, unique within this plan. Lets `dependsOn` reference sibling phases so
   *  persistPlan can build a real DAG (independent branches) instead of a forced linear chain.
   *  Absent → the whole plan falls back to the legacy prev→next chain (back-compat). */
  id?: string;
  /** Ids of phases (within THIS plan) that must finish before this one starts. `[]` = no ordering
   *  need → starts immediately (parallel). Undefined when the planner omitted it. */
  dependsOn?: string[];
}
