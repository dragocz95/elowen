import { rawTemplate, _resetPromptCache } from './index.js';

/** The shipped default of the editable autopilot planner prompt (`autopilot.prompt` seeds from it).
 *  Lives in prompts/ — not in the overseer — because the CONFIG defaults need it and the overseer
 *  moves into the agents plugin with the extraction; `planner-fallback` is the built-in safety net
 *  used only when `planner.md` is unreadable. */
export function defaultPromptTemplate(): string {
  try { return rawTemplate('planner'); }
  catch { return rawTemplate('planner-fallback'); }
}

/** Drop the cached template so the next read re-loads planner.md. For tests (the loader cache
 *  otherwise leaks across cases) and for picking up an on-disk template edit without a restart. */
export function _resetDefaultCache(): void { _resetPromptCache(); }
