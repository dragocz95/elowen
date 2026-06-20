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

export interface Phase { title: string; type: string; agent?: string; details?: string }

/** Sanitize a model-supplied agent name into a tmux-safe single token. Keeps `_` and `-` (both legal
 *  in tmux session names) so multi-word names like "code-reviewer" survive instead of collapsing to
 *  "codereviewer"; strips only `:` (the session-name separator) and whitespace/other characters. */
function sanitizeAgentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return clean.length > 0 ? clean : undefined;
}

/** Per-project context fed to the Pilot — the project's saved "Pilot info" notes. */
export interface PlanProjectContext { notes?: string }

/** Render the project notes into a planning-context block, or '' when there are none. */
function projectContextBlock(project?: PlanProjectContext): string {
  const notes = project?.notes?.trim();
  return notes ? `Project context (use this when planning):\n${notes}` : '';
}

/**
 * Build the decomposition prompt: substitute the goal ({{goal}}) and the project's Pilot
 * notes ({{project}}) into the template. If the template has no {{project}} placeholder, the
 * context block is prepended so saved templates still pick up the notes.
 */
export function planPrompt(goal: string, template?: string, project?: PlanProjectContext): string {
  let tpl = (template ?? defaultPromptTemplate()).trim();
  const ctx = projectContextBlock(project);
  if (tpl.includes('{{project}}')) tpl = tpl.replaceAll('{{project}}', ctx).trim();
  else if (ctx) tpl = `${ctx}\n\n${tpl}`;
  return tpl.includes('{{goal}}') ? tpl.replaceAll('{{goal}}', goal) : `${tpl}\n\nGoal: ${goal}`;
}

/** Extract and validate the phase array from raw LLM output. Throws on unparseable/empty output. */
export function parsePhases(text: string): Phase[] {
  const raw = extractJson(text, '['); // first balanced array; caller wraps in try/catch
  if (!Array.isArray(raw)) throw new Error('plan output is not an array');
  const phases = raw
    .filter((p): p is { title: string; type?: unknown; agent?: unknown; details?: unknown } => !!p && typeof (p as { title?: unknown }).title === 'string' && (p as { title: string }).title.trim().length > 0)
    .map((p) => ({
      title: p.title.trim(),
      type: VALID_TYPES.has(String(p.type)) ? String(p.type) : 'task',
      agent: sanitizeAgentName(p.agent),
      details: typeof p.details === 'string' && p.details.trim() ? p.details.trim() : undefined,
    }));
  if (phases.length === 0) throw new Error('plan output had no valid phases');
  return phases;
}

/** Run the LLM decomposition for a goal and return validated phases. */
export async function decompose(inf: InferenceClient, goal: string, template?: string, project?: PlanProjectContext): Promise<Phase[]> {
  const { text } = await inf.decide(planPrompt(goal, template, project));
  return parsePhases(text);
}
