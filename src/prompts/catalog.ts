/** The single source of truth for which prompt templates a user may override, how they group in the
 *  account UI, which `{{vars}}` each one expects (shown as hints so a user doesn't drop a required
 *  placeholder), and whether the model's output is parsed as JSON (so the UI can warn — though the
 *  parser is hardened with a repair pass, see overseer/jsonRepair). `planner-fallback` is intentionally
 *  excluded: it's the built-in safety net used only when `planner` is unreadable, not a user surface. */

type PromptGroup = 'workers' | 'pilot' | 'overseer' | 'advisor' | 'cli';

export interface PromptCatalogEntry {
  /** Template name == the `.md` filename without suffix; the override key in `user_prompts`. */
  name: string;
  group: PromptGroup;
  /** Placeholders the template substitutes — surfaced in the editor so users keep them intact. */
  vars: string[];
  /** The model output is parsed as JSON downstream; editing this risks the contract (repair softens it). */
  jsonContract: boolean;
  /** The template itself is system-managed: the user's saved text is APPENDED to the default as extra
   *  instructions instead of replacing it (the Elowen advisor identity stays intact). */
  appendOnly?: boolean;
}

const WORKER_VARS = ['agentName', 'taskId', 'titlePart', 'detailsPart', 'resumePart', 'closeCommand'];

export const EDITABLE_PROMPTS: PromptCatalogEntry[] = [
  { name: 'worker', group: 'workers', vars: [...WORKER_VARS, 'cli'], jsonContract: false },
  { name: 'worker-resume', group: 'workers', vars: [...WORKER_VARS, 'cli'], jsonContract: false },
  { name: 'worker-phase', group: 'workers', vars: [...WORKER_VARS, 'epicId', 'cli'], jsonContract: false },
  // The embedded (Elowen AI) worker: no CLI — it closes its task via the ElowenCloseTask tool.
  { name: 'worker-brain', group: 'workers', vars: ['agentName', 'taskId', 'titlePart', 'detailsPart', 'resumePart'], jsonContract: false },
  // The on-demand control guide an agent fetches with `elowen help` (rendered by guideService). `agent-guide`
  // is the base; `agent-guide-phase` is appended for a mission phase (sibling rules, handoff, epic close).
  { name: 'agent-guide', group: 'workers', vars: ['cli', 'closeCommand'], jsonContract: false },
  { name: 'agent-guide-phase', group: 'workers', vars: ['epicId', 'cli', 'epicCloseCommand'], jsonContract: false },
  { name: 'pilot', group: 'pilot', vars: ['goal', 'notes', 'submit', 'jobId', 'models', 'parallelism'], jsonContract: true },
  { name: 'planner', group: 'pilot', vars: ['goal', 'project', 'models', 'parallelism'], jsonContract: true },
  { name: 'overseer', group: 'overseer', vars: ['missionId', 'cli', 'codeReview'], jsonContract: false },
  { name: 'code-review', group: 'overseer', vars: [], jsonContract: false },
  { name: 'decision-header', group: 'overseer', vars: ['subject', 'approveGuidance'], jsonContract: true },
  { name: 'decision-prompt', group: 'overseer', vars: ['autonomy', 'question', 'context', 'options'], jsonContract: true },
  { name: 'decision-question', group: 'overseer', vars: ['autonomy', 'question', 'context', 'options'], jsonContract: true },
  { name: 'elowen', group: 'advisor', vars: ['userName', 'personality', 'agentName'], jsonContract: false, appendOnly: true },
  { name: 'elowen-platform', group: 'advisor', vars: ['ownerName', 'agentName'], jsonContract: false, appendOnly: true },
  { name: 'cli/plan-mode', group: 'cli', vars: [], jsonContract: false },
  { name: 'cli/workflow-mode', group: 'cli', vars: [], jsonContract: false },
];

const EDITABLE_NAMES = new Set(EDITABLE_PROMPTS.map((p) => p.name));

/** Whether a template name is a user-overridable prompt (guards the override API + resolution path). */
export function isEditablePrompt(name: string): boolean {
  return EDITABLE_NAMES.has(name);
}

const APPEND_ONLY = new Set(EDITABLE_PROMPTS.filter((p) => p.appendOnly).map((p) => p.name));

/** True when the user's saved text appends to the default instead of replacing it. */
export function isAppendOnlyPrompt(name: string): boolean {
  return APPEND_ONLY.has(name);
}
