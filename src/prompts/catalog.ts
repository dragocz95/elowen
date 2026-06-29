/** The single source of truth for which prompt templates a user may override, how they group in the
 *  account UI, which `{{vars}}` each one expects (shown as hints so a user doesn't drop a required
 *  placeholder), and whether the model's output is parsed as JSON (so the UI can warn — though the
 *  parser is hardened with a repair pass, see overseer/jsonRepair). `planner-fallback` is intentionally
 *  excluded: it's the built-in safety net used only when `planner` is unreadable, not a user surface. */

type PromptGroup = 'workers' | 'pilot' | 'overseer' | 'advisor';

export interface PromptCatalogEntry {
  /** Template name == the `.md` filename without suffix; the override key in `user_prompts`. */
  name: string;
  group: PromptGroup;
  /** Placeholders the template substitutes — surfaced in the editor so users keep them intact. */
  vars: string[];
  /** The model output is parsed as JSON downstream; editing this risks the contract (repair softens it). */
  jsonContract: boolean;
}

const WORKER_VARS = ['agentName', 'taskId', 'titlePart', 'detailsPart', 'resumePart', 'closeCommand'];

export const EDITABLE_PROMPTS: PromptCatalogEntry[] = [
  { name: 'worker', group: 'workers', vars: WORKER_VARS, jsonContract: false },
  { name: 'worker-resume', group: 'workers', vars: WORKER_VARS, jsonContract: false },
  { name: 'worker-phase', group: 'workers', vars: [...WORKER_VARS, 'epicId', 'cli'], jsonContract: false },
  { name: 'worker-epic-close', group: 'workers', vars: ['epicId', 'cli', 'epicCloseCommand'], jsonContract: false },
  { name: 'pilot', group: 'pilot', vars: ['goal', 'notes', 'submit', 'jobId', 'models', 'parallelism'], jsonContract: true },
  { name: 'planner', group: 'pilot', vars: ['goal', 'project', 'models', 'parallelism'], jsonContract: true },
  { name: 'overseer', group: 'overseer', vars: ['missionId', 'cli', 'codeReview'], jsonContract: false },
  { name: 'code-review', group: 'overseer', vars: [], jsonContract: false },
  { name: 'decision-header', group: 'overseer', vars: ['subject', 'approveGuidance'], jsonContract: true },
  { name: 'decision-prompt', group: 'overseer', vars: ['autonomy', 'question', 'context', 'options'], jsonContract: true },
  { name: 'decision-question', group: 'overseer', vars: ['autonomy', 'question', 'context', 'options'], jsonContract: true },
  { name: 'advisor', group: 'advisor', vars: ['userName'], jsonContract: false },
];

const EDITABLE_NAMES = new Set(EDITABLE_PROMPTS.map((p) => p.name));

/** Whether a template name is a user-overridable prompt (guards the override API + resolution path). */
export function isEditablePrompt(name: string): boolean {
  return EDITABLE_NAMES.has(name);
}
