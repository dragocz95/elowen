import { runApprovalFlow } from './components.js';
import { runAskFlow } from './askFlow.js';
import { openPicker } from './picker.js';
import type { AskQuestion } from '../../brain/events.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources } from './chatCapabilities.js';

export interface Flows {
  launchAsk(id: string, questions: AskQuestion[], kind?: 'approval'): void;
  /** Drop the dock for a question settled elsewhere (answered in the web, timed out, or aborted).
   *  No-op unless `id` is the question currently on screen, so a late event cannot steal a dock that
   *  already belongs to the next question. */
  closeAsk(id: string): void;
  openPlanDecision(): void;
}

/** Modal/approval flows that park the running turn: AskUserQuestion pickers, blocked tool-permission
 *  approvals, and the plan-mode "implement it?" follow-up. */
export function createFlows(
  rt: ChatState,
  resources: Pick<ChatApplicationResources, 'client' | 'tui' | 'editor' | 'editorSlot' | 'lifetime'>,
  actions: Pick<ChatApplicationActions, 'render'>,
): Flows {
  const { client, tui, editor, editorSlot, lifetime } = resources;
  const { render } = actions;

  // Drive the interactive picker flow for a parked AskUserQuestion, POST the answer (Esc aborts the
  // turn). Shared by the live `ask` event and the reconnect restore (boot.pendingAsk). An `approval`
  // kind (a blocked tool-permission ask) takes the dedicated warning-toned modal instead: 1/2/3 or
  // arrows+Enter pick, and Esc answers Deny — it never aborts the turn (the tool just reports the
  // denial to the model and the run continues).
  // The question on screen right now, so a remote resolution can take it down. Cleared by whichever
  // exit happens first — a local decision here, or closeAsk() below.
  let onScreen: { id: string; close: () => void } | null = null;
  const settled = (id: string): void => { if (onScreen?.id === id) onScreen = null; };

  const launchAsk = (id: string, questions: AskQuestion[], kind?: 'approval'): void => {
    const q = questions[0];
    if (kind === 'approval' && q) {
      const handle = runApprovalFlow({
        tui, slot: editorSlot, editor, question: q,
        onDecision: (label) => {
          settled(id);
          lifetime.runSession(
            () => client.answer(id, [{ header: q.header, selected: [label] }]),
            () => {},
            () => { /* turn may have gone */ },
          );
        },
      });
      onScreen = { id, close: handle.close };
      return;
    }
    const handle = runAskFlow({
      tui, slot: editorSlot, editor, questions, agentName: rt.brand.agentName,
      onComplete: (answers) => {
        settled(id);
        lifetime.runSession(() => client.answer(id, answers), () => {}, () => { /* turn may have gone */ });
      },
      onCancel: () => {
        settled(id);
        lifetime.runSession(() => client.abort(), () => {}, () => { /* already settled */ });
      },
    });
    onScreen = { id, close: handle.close };
  };

  const closeAsk = (id: string): void => {
    if (onScreen?.id !== id) return;
    const { close } = onScreen;
    onScreen = null;
    close();
  };

  /** Plan-mode follow-up: the agent finished a turn whose ExitPlanMode call submitted a plan — ask
   *  whether to implement it now. "Implement" flips to build mode and sends the go-ahead through the
   *  normal submit path; "Cancel" stays in plan mode for further refinement. */
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

  return { launchAsk, closeAsk, openPlanDecision };
}
