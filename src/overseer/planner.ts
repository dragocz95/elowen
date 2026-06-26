import type { InferenceClient } from '../inference/types.js';
import { rawTemplate, _resetPromptCache } from '../prompts/index.js';
import { extractJson } from './llmParse.js';

/** Default planner prompt template (editable in Settings). Read from prompts/planner.md, with a
 *  built-in fallback (prompts/planner-fallback.md) if the default cannot be read (e.g. not copied
 *  into dist). The loader caches both, so repeated calls do not re-touch disk. */
export function defaultPromptTemplate(): string {
  try { return rawTemplate('planner'); }
  catch { return rawTemplate('planner-fallback'); }
}

/** Drop the cached template so the next read re-loads planner.md. For tests (the loader cache
 *  otherwise leaks across cases) and for picking up an on-disk template edit without a restart. */
export function _resetDefaultCache(): void { _resetPromptCache(); }

/** Task types a phase may take; anything else is coerced to 'task'. */
export const VALID_TYPES = new Set(['task', 'feature', 'bug', 'chore']);

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

/** Sanitize a model-supplied agent name into a tmux-safe single token. Keeps `_` and `-` (both legal
 *  in tmux session names) so multi-word names like "code-reviewer" survive instead of collapsing to
 *  "codereviewer"; strips only `:` (the session-name separator) and whitespace/other characters. */
function sanitizeAgentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return clean.length > 0 ? clean : undefined;
}

/** Sanitize a planner-local phase slug (an `id` or a `dependsOn` entry) to `[A-Za-z0-9_-]`. Returns
 *  undefined when nothing legal remains, so blank/garbage ids are simply dropped (the phase then has
 *  no id and persistPlan treats it as dependency-free). */
function sanitizeSlug(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return clean.length > 0 ? clean : undefined;
}

/** Per-project context fed to the Pilot — the project's saved "Pilot info" notes. */
export interface PlanProjectContext { notes?: string }

/** Render the project notes into a planning-context block, or '' when there are none. */
function projectContextBlock(project?: PlanProjectContext): string {
  const notes = project?.notes?.trim();
  return notes ? `Project context (use this when planning):\n${notes}` : '';
}

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

/**
 * Build the decomposition prompt: substitute the goal ({{goal}}) and the project's Pilot
 * notes ({{project}}) into the template. If the template has no {{project}} placeholder, the
 * context block is prepended so saved templates still pick up the notes.
 */
export function planPrompt(goal: string, template?: string, project?: PlanProjectContext, models?: string, parallelism?: string): string {
  let tpl = (template ?? defaultPromptTemplate()).trim();
  const ctx = projectContextBlock(project);
  if (tpl.includes('{{project}}')) tpl = tpl.replaceAll('{{project}}', ctx).trim();
  else if (ctx) tpl = `${ctx}\n\n${tpl}`;
  const mdl = models ?? '';
  if (tpl.includes('{{models}}')) tpl = tpl.replaceAll('{{models}}', mdl);
  else if (mdl) tpl = `${mdl}\n\n${tpl}`;
  const par = parallelism ?? '';
  if (tpl.includes('{{parallelism}}')) tpl = tpl.replaceAll('{{parallelism}}', par);
  else if (par) tpl = `${par}\n\n${tpl}`;
  return tpl.includes('{{goal}}') ? tpl.replaceAll('{{goal}}', goal) : `${tpl}\n\nGoal: ${goal}`;
}

/** Extract and validate the phase array from raw LLM output. Throws on unparseable/empty output. */
export function parsePhases(text: string): Phase[] {
  const raw = extractJson(text, '['); // first balanced array; caller wraps in try/catch
  if (!Array.isArray(raw)) throw new Error('plan output is not an array');
  const phases = raw
    .filter((p): p is { title: string; type?: unknown; agent?: unknown; details?: unknown; exec?: unknown; id?: unknown; dependsOn?: unknown } => !!p && typeof (p as { title?: unknown }).title === 'string' && (p as { title: string }).title.trim().length > 0)
    .map((p) => ({
      title: p.title.trim(),
      type: VALID_TYPES.has(String(p.type)) ? String(p.type) : 'task',
      agent: sanitizeAgentName(p.agent),
      details: typeof p.details === 'string' && p.details.trim() ? p.details.trim() : undefined,
      exec: typeof p.exec === 'string' && p.exec.trim() ? p.exec.trim() : undefined,
      id: sanitizeSlug(p.id),
      // Only an actual array becomes dependsOn; each entry is slug-sanitized and garbage dropped. A
      // non-array (or absent) stays undefined → persistPlan reads it as "no declared dependencies".
      dependsOn: Array.isArray(p.dependsOn)
        ? p.dependsOn.map(sanitizeSlug).filter((x): x is string => !!x)
        : undefined,
    }));
  if (phases.length === 0) throw new Error('plan output had no valid phases');
  return phases;
}

/** Run the LLM decomposition for a goal and return validated phases. */
export async function decompose(inf: InferenceClient, goal: string, template?: string, project?: PlanProjectContext, models?: string, parallelism?: string): Promise<Phase[]> {
  const { text } = await inf.decide(planPrompt(goal, template, project, models, parallelism));
  return parsePhases(text);
}
