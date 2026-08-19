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
    description: 'Submit the plan you wrote in plan mode and ask the user to approve leaving plan mode and '
      + 'starting implementation. Call it exactly once, at the END of a planning turn, and only after you '
      + 'have written the plan to the plan file named in the plan mode instructions — the plan is READ from '
      + 'that file and is not a parameter, so this tool takes no arguments. It refuses outside plan mode '
      + '(if your plan was already approved, just continue implementing) and refuses when the plan file is '
      + 'empty or missing, answering with the exact path to write first. Calling it ENDS your turn and is '
      + 'not approval: stop, do not start implementing and do not ask again in prose — the user\'s decision '
      + 'arrives afterwards, and the plan stays on disk so you can re-read it while you work.',
    parameters: Type.Object({}),
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
