import { runApprovalFlow } from './components.js';
import { runAskFlow } from './askFlow.js';
import { openPicker } from './picker.js';
import type { AskQuestion } from '../../brain/events.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources } from './chatCapabilities.js';

export interface Flows {
  launchAsk(id: string, questions: AskQuestion[], kind?: 'approval'): void;
  openPlanDecision(): void;
}

/** Modal/approval flows that park the running turn: ask_user_question pickers, blocked tool-permission
 *  approvals, and the plan-mode "implement it?" follow-up. */
export function createFlows(
  rt: ChatState,
  resources: Pick<ChatApplicationResources, 'client' | 'tui' | 'editor' | 'editorSlot' | 'lifetime'>,
  actions: Pick<ChatApplicationActions, 'render'>,
): Flows {
  const { client, tui, editor, editorSlot, lifetime } = resources;
  const { render } = actions;

  // Drive the interactive picker flow for a parked ask_user_question, POST the answer (Esc aborts the
  // turn). Shared by the live `ask` event and the reconnect restore (boot.pendingAsk). An `approval`
  // kind (a blocked tool-permission ask) takes the dedicated warning-toned modal instead: 1/2/3 or
  // arrows+Enter pick, and Esc answers Deny — it never aborts the turn (the tool just reports the
  // denial to the model and the run continues).
  const launchAsk = (id: string, questions: AskQuestion[], kind?: 'approval'): void => {
    const q = questions[0];
    if (kind === 'approval' && q) {
      runApprovalFlow({
        tui, slot: editorSlot, editor, question: q,
        onDecision: (label) => lifetime.run(
          () => client.answer(id, [{ header: q.header, selected: [label] }]),
          () => {},
          () => { /* turn may have gone */ },
        ),
      });
      return;
    }
    runAskFlow({
      tui, slot: editorSlot, editor, questions,
      onComplete: (answers) => lifetime.run(() => client.answer(id, answers), () => {}, () => { /* turn may have gone */ }),
      onCancel: () => lifetime.run(() => client.abort(), () => {}, () => { /* already settled */ }),
    });
  };

  /** Plan-mode follow-up: the agent finished a turn containing a <proposed_plan> block — ask whether to
   *  implement it now. "Implement" flips to build mode and sends the go-ahead through the normal submit
   *  path; "Cancel" stays in plan mode for further refinement. */
  const openPlanDecision = (): void => {
    openPicker({
      tui, editor, title: 'Plan ready',
      items: [
        { value: 'implement', label: 'Implement plan', description: 'switch to build mode and start implementing' },
        { value: 'cancel', label: 'Cancel', description: 'stay in plan mode and keep refining' },
      ],
      footer: 'enter pick · esc close',
      onPick: (v) => {
        if (v !== 'implement') return;
        rt.workMode = 'build';
        render();
        editor.onSubmit?.('Implement the plan you proposed above.');
      },
    });
  };

  return { launchAsk, openPlanDecision };
}
