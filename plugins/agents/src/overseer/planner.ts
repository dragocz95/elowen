/** Planner instruction blocks for the plugin's Pilot flow.
 *
 *  The actual goal→phases decomposition (planPrompt/parsePhases/decompose) stayed CORE — /tasks/plan
 *  is deliberately plugin-less — so this copy keeps only what the plugin's pilotAgent composes into
 *  its own prompt: the models and parallelism instruction blocks, plus the Phase re-export its
 *  callers type against. */
// Phase is part of the CORE event contract (rides the `plan` SSE event) — defined in shared/.
import type { Phase } from '../../../../src/shared/agentEvents.js';

export type { Phase };

/** Render the enabled, described models into a planner instruction block. Only models that are in
 *  `allowedExecs` AND have a non-empty note are listed — the planner can only sensibly pick a model
 *  it has a description for. Returns '' when none qualify (the caller then injects no model guidance,
 *  so the planner emits no `exec` and tasks fall back to the configured default). */
export function modelsBlock(allowedExecs: string[], modelNotes: Record<string, string>): string {
  const lines = allowedExecs
    .map((e) => ({ e, note: modelNotes[e]?.trim() }))
    .filter((x): x is { e: string; note: string } => !!x.note)
    .map((x) => `- ${x.e}: ${x.note}`);
  if (lines.length === 0) return '';
  return [
    'Available models — for each phase additionally include an "exec" field set to the id of the model best suited to that phase, chosen ONLY from this list:',
    ...lines,
  ].join('\n');
}

/** Planner instruction describing whether phases may run in parallel. Parallelism only materialises in
 *  isolated worktrees (a shared checkout is single-writer), so we invite independent branches only when
 *  BOTH more than one session is allowed AND the mission runs PR-native; otherwise we ask for a
 *  sequential chain so the planner doesn't emit false parallelism the engine would serialize anyway. */
export function parallelismBlock(maxSessions: number, isolated: boolean): string {
  if (maxSessions > 1 && isolated) {
    return `Parallelism: up to ${maxSessions} phases can run AT THE SAME TIME, sharing ONE working tree. Independent phases must therefore touch DISJOINT files/areas — if two phases would edit the same files (or one would rewrite another's), the agents clobber each other, so make one depend on the other instead. Actively look for file-disjoint branches of work and give them no dependency (dependsOn: []) — a good plan here is a DAG several phases WIDE, not one long chain. Make each phase's details state its file/area boundary explicitly so the parallel agents stay in their lanes.`;
  }
  return `Parallelism: phases run ONE AT A TIME (a single shared working copy). Order them so each builds on the previous — a linear chain (each phase lists the previous one in dependsOn) is the expected shape here.`;
}
