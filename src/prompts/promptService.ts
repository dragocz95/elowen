import { applyVars, rawTemplate, type PromptVars } from './index.js';
import { isEditablePrompt, isAppendOnlyPrompt } from './catalog.js';
import type { UserPromptStore } from '../store/userPromptStore.js';

/** User-aware prompt rendering: resolves a template to the given user's override (if they've edited it
 *  and it's an editable template), else the shipped `.md` default, then substitutes `{{vars}}`. The one
 *  place override-vs-default resolution lives, so every spawn path (worker/pilot/overseer/advisor/
 *  decision) renders prompts the same way. With no userId — or no override — it equals the file `render`. */
export class PromptService {
  constructor(private userPrompts: UserPromptStore) {}

  render(name: string, vars: PromptVars = {}, userId?: number | null): string {
    const override = userId != null && isEditablePrompt(name) ? this.userPrompts.get(userId, name) : null;
    // Append-only templates (the advisor identity) keep the shipped default; the user's text rides
    // along as extra instructions instead of replacing the system prompt.
    if (override && isAppendOnlyPrompt(name)) {
      return applyVars(`${rawTemplate(name)}\n\n## User preferences (added by the user)\n${override}`, vars);
    }
    return applyVars(override ?? rawTemplate(name), vars);
  }
}
