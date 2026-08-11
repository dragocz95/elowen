import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginPromptEntry } from '../../../src/plugins/api.js';

/** Absolute path of the plugin's prompt template dir. The compiled entry lives at
 *  `plugins/agents/dist/…`, the templates at `plugins/agents/prompts/` — one level up, so the same
 *  resolution works in the repo checkout and in the packaged `dist/plugins/agents` copy. */
export const AGENTS_PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

const WORKER_VARS = ['agentName', 'taskId', 'titlePart', 'detailsPart', 'resumePart', 'closeCommand'];

/** The subsystem's editable prompt templates — the exact catalog metadata these names carried in the
 *  core catalog (src/prompts/catalog.ts) before the extraction. Names stay BARE so a user's existing
 *  `user_prompts` override keeps applying; resolution is user override → these files. */
export const AGENTS_PROMPTS: PluginPromptEntry[] = [
  { name: 'worker', group: 'workers', vars: [...WORKER_VARS, 'cli'], jsonContract: false },
  { name: 'worker-resume', group: 'workers', vars: [...WORKER_VARS, 'cli'], jsonContract: false },
  { name: 'worker-phase', group: 'workers', vars: [...WORKER_VARS, 'epicId', 'cli'], jsonContract: false },
  // The on-demand control guide an agent fetches with `elowen help` (rendered by the guide route).
  // `agent-guide` is the base; `agent-guide-phase` is appended for a mission phase (sibling rules,
  // handoff, epic close).
  { name: 'agent-guide', group: 'workers', vars: ['cli', 'closeCommand'], jsonContract: false },
  { name: 'agent-guide-phase', group: 'workers', vars: ['epicId', 'cli', 'epicCloseCommand'], jsonContract: false },
  { name: 'pilot', group: 'pilot', vars: ['goal', 'notes', 'submit', 'jobId', 'models', 'parallelism'], jsonContract: true },
  { name: 'overseer', group: 'overseer', vars: ['missionId', 'cli', 'codeReview'], jsonContract: false },
  { name: 'code-review', group: 'overseer', vars: [], jsonContract: false },
  { name: 'decision-header', group: 'overseer', vars: ['subject', 'approveGuidance'], jsonContract: true },
  { name: 'decision-prompt', group: 'overseer', vars: ['autonomy', 'question', 'context', 'options'], jsonContract: true },
  { name: 'decision-question', group: 'overseer', vars: ['autonomy', 'question', 'context', 'options'], jsonContract: true },
];
