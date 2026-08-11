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

/** One async planning job (relay or agent backend). Part of the shared core↔agents contract: the store
 *  lives in the agents subsystem, but the plan/replan API routes and the event-tenancy resolver read and
 *  mutate these records across the plugin boundary. */
export interface PlanJob {
  id: string; epicId: string | null; goal: string; projectId: number; exec?: string; autoModel?: boolean;
  /** Per-mission Autopilot overrides; absent/empty inherits Settings. */
  pilotExec?: string; overseerExec?: string;
  /** Optional short mission name → epic title. Empty/absent falls back to the goal, so the epic title
   *  is never blank. The full goal always lands in the epic description regardless. */
  name?: string;
  dryRun: boolean; engage?: { autonomy: string; maxSessions: number; preserveReviewBudget?: boolean };
  /** How many phases the mission may run in parallel — drives the Pilot's parallelism guidance at PLAN
   *  time, independent of `engage`. Set even when planning without immediate engage ("plan now, engage
   *  later"), so the planned DAG matches the intended concurrency. Defaults to 1. */
  maxSessions?: number;
  /** Per-task GitHub PR-native override, stamped onto the epic as a `pr:on`/`pr:off` label so this
   *  mission can opt in/out independently of the project/global default. Undefined/null = inherit. */
  prEnabled?: boolean | null;
  status: PlanJobStatus; phases: Phase[]; error?: string;
  /** The user who triggered the plan. Stamped onto the epic + every phase (created_by) so the spawned
   *  Pilot and phase agents resolve to this owner's prompt overrides. Null for system/legacy plans. */
  createdBy?: number | null;
  /** tmux session of the Pilot agent in agent-mode planning, so the client can live-preview the
   *  planner's pane while it works. Unset for relay-mode planning (synchronous, no tmux). */
  sessionName?: string;
}

/** What kind of verdict the parked overseer is being asked for. Shared contract: the deriver/engine
 *  enqueue these, while the core overseer long-poll routes deliver and resolve them. */
export type DecisionKind = 'prompt' | 'review' | 'question' | 'message' | 'check';

/** A structured overseer verdict (no model output is parsed — the agent posts this shape). */
export interface DecisionResult {
  approve: boolean;
  confidence: number;
  rationale: string;
  /** For a 'check' decision (the liveness sweep woke the overseer about an idle worker): the overseer
   *  wants the worker killed and relaunched (it judged it genuinely stuck, not just slow). Distinct from
   *  `message` (nudge it) and a bare `approve:false` (escalate to a human). */
  restart?: boolean;
  /** For a 'question' decision: the option id the overseer picked. Absent ⇒ escalate to a human
   *  (also the shape of a timeout/drain verdict, which therefore escalates the question). */
  choice?: string;
  /** For a 'message' decision (worker asked the autopilot a free-text question): the overseer's
   *  free-text reply. Absent ⇒ the overseer escalated (or timed out) → the ask falls to the human
   *  window. Distinct from `choice`/`approve`, which don't apply to a free-text exchange. */
  message?: string;
  /** True only when the overseer never answered (the decision timed out): there is NO real verdict,
   *  so the decision must be handed to a human and never auto-acted on. In particular a post-done
   *  review must NOT self-heal/re-run the phase on this — that turns a slow/absent overseer into an
   *  infinite reopen loop. A genuine overseer reject leaves this unset. */
  escalated?: boolean;
}

/** One decision awaiting a verdict, as the overseer long-poll delivers it. */
export interface PendingDecision { id: string; kind: DecisionKind; context: Record<string, unknown> }

/** A mission row as the API serves it (list/detail/SSE) — the CORE side of the contract, like PlanJob
 *  above: the store that writes it lives in the agents plugin, while core routes/tenancy keep reading
 *  the same shape through the AgentsMissions port. */
export interface Mission {
  id: string; epic_id: string; autonomy: string; max_sessions: number;
  state: import('../store/types.js').MissionState;
  /** The user who engaged the mission; null for legacy/system missions. Drives push-notification routing. */
  created_by: number | null;
  /** Empty means inherit the workspace Autopilot setting. */
  pilot_exec: string;
  /** Empty means inherit the workspace Autopilot setting. */
  overseer_exec: string;
}
