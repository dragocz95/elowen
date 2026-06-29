import { renderPromptFor } from '../../prompts/index.js';
import { resolveOwnerId } from '../../prompts/owner.js';
import type { ServerDeps } from '../deps.js';

export interface GuideService {
  /** Render the context-aware Orca control guide for a task (what `orca help` prints to a running
   *  agent): the base how-to-work + ask + close guide, plus a mission-phase appendix (sibling rules,
   *  handoff notes, epic close) when the task is a phase of an ACTIVE mission. Null if the task is
   *  unknown. Rendered through the task owner's prompt overrides, exactly like the spawn preamble. */
  render(taskId: string): string | null;
}

/** Backs `orca help` (GET /tasks/:id/guide). The agent's spawn preamble is deliberately short and just
 *  points here, so the full control tutorial lives in ONE place (the `agent-guide` templates) instead of
 *  being copied into every worker preamble — and stays per-user editable like the other prompts. */
export function createGuideService(d: ServerDeps): GuideService {
  const cli = d.cli ?? 'orca';
  const renderPrompt = (name: string, vars: Record<string, string>, ownerId: number | null): string =>
    renderPromptFor(d.prompts, name, vars, ownerId);

  function render(taskId: string): string | null {
    const task = d.tasks.get(taskId);
    if (!task) return null;
    const ownerId = resolveOwnerId(d, { taskId });
    const closeCommand = `${cli} close ${taskId}`;
    let text = renderPrompt('agent-guide', { cli, closeCommand }, ownerId);
    // A phase belongs to an epic; the mission id is `m-<epicId>`. Only an ACTIVE mission gets the phase
    // appendix — a standalone task (or a phase whose mission has ended) gets the base guide alone. The
    // worker preamble tells a phase agent to run `orca help` BEFORE it starts (while the mission is still
    // live), so it captures the epic-close steps up front; a re-run after the mission disengages would
    // omit them, which is fine because by then the epic is closing anyway.
    const epicId = task.parent_id;
    const isPhase = !!epicId && !!d.missions.activeForEpic(epicId);
    if (isPhase && epicId) {
      const epicCloseCommand = `${cli} close ${epicId}`;
      text += `\n\n${renderPrompt('agent-guide-phase', { epicId, cli, epicCloseCommand }, ownerId)}`;
    }
    return text;
  }

  return { render };
}
