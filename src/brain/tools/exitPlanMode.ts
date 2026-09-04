import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentSessionId, currentTurnMode } from '../../plugins/policyContext.js';
import { readPlan } from '../continuity/planStore.js';
import { planFilePath } from '../../shared/paths.js';
import { EXIT_PLAN_MODE_TOOL } from '../../shared/planTool.js';

/** Refusal when the tool is called outside plan mode. Adapted from the reference's validateInput text,
 *  which already answers the question the model asks next ("was my plan approved earlier?"). */
const NOT_IN_PLAN_MODE = 'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. '
  + 'If your plan was already approved, continue with implementation.';

const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

/** Present the finished plan for the user's decision — the explicit end of a planning turn.
 *
 *  This replaces sniffing the model's prose for a `<proposed_plan>` tag. A tag in streamed text cannot be
 *  told apart from the model merely QUOTING the tag while discussing it, which is how a conversation about
 *  plan mode used to raise a plan panel; a tool call is unambiguous by construction.
 *
 *  The plan is NOT a parameter. The model writes it to the session's plan file (the only path plan mode
 *  lets it write) and this tool reads it back from disk, so one document is the single source of truth for
 *  the model, the approval UI, the post-compaction re-injection and the user's own editor. */
export function buildExitPlanModeTool() {
  return defineTool({
    name: EXIT_PLAN_MODE_TOOL,
    label: 'Submit plan',
    description: [
      'Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.',
      '## How This Tool Works\n- You should have already written your plan to the plan file specified in the plan mode system message\n- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote\n- This tool simply signals that you\'re done planning and ready for the user to review and approve\n- The user will see the contents of your plan file when they review it',
      '## When to Use This Tool\nIMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you\'re gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.',
      '## Before Using This Tool\nEnsure your plan is complete and unambiguous:\n- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)\n- Once your plan is finalized, use THIS tool to request approval',
      '**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that\'s exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.',
      '## Examples\n1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.\n2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.\n3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.',
      'The optional allowedPrompts field is deprecated and accepted only for transcript compatibility. Elowen ignores it and never derives permission or authority from it.',
    ].join('\n\n'),
    parameters: Type.Object({
      allowedPrompts: Type.Optional(Type.Array(Type.Object({
        tool: Type.Literal('Bash', { description: 'The tool this prompt applies to' }),
        prompt: Type.String({ description: 'Semantic description of the action, e.g. "run tests", "install dependencies"' }),
      }), {
        description: 'Deprecated: no longer used. Accepted for transcript compatibility and ignored; never changes Elowen permissions.',
      })),
    }),
    execute: async () => {
      // Mode first. Outside plan mode there is nothing to exit, and reading a stale plan file would let a
      // build turn resurrect an old plan as though it were fresh.
      if (currentTurnMode() !== 'plan') return toolText(NOT_IN_PLAN_MODE);
      const sessionId = currentSessionId();
      if (!sessionId) return toolText(NOT_IN_PLAN_MODE);

      const plan = readPlan(sessionId);
      // An empty or missing file means the model reached for the tool before writing anything. Say where
      // the file is rather than just refusing, so the next attempt can succeed without guessing.
      if (!plan) {
        return toolText(`No plan has been written yet. Write your plan to ${planFilePath(process.env, sessionId)} first, then call ${EXIT_PLAN_MODE_TOOL} again.`);
      }
      // The plan rides `details`, which reaches the CLIENT but not the model — the approval UI needs the
      // markdown to render, while the model has just written it and gains nothing from being handed it
      // back. (`detail` on the wire event is derived from the call's ARGUMENTS, and this tool has none,
      // so details is the carrier; the same channel the files plugin uses for its path metadata.)
      //
      // The turn ENDS here. The user's decision is taken after it settles, so the model must not read this
      // as permission to start — an approval it has not been given yet.
      return {
        content: [{ type: 'text' as const, text: 'Your plan has been submitted for the user to review.\n\n'
          + 'Stop here and wait for their decision. Do NOT begin implementing, and do not ask whether the plan '
          + 'is acceptable — submitting it already asked. If they approve it, you will be told so and may then '
          + 'start; the plan stays on disk so you can re-read it while you work.' }],
        details: { plan },
      };
    },
  });
}
