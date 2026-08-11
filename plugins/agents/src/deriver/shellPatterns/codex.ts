import type { DetectedPrompt } from './types.js';

// Codex approval gate (when not run with --dangerously-bypass-approvals-and-sandbox).
function detectApproval(output: string): DetectedPrompt | null {
  if (!/Allow command\?|Approve this command\?|Run command\?/i.test(output)) return null;
  return {
    question: 'Codex requests approval to run a command.',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    context: 'Codex approval',
    acceptKeys: ['Enter'],
  };
}

// NOTE: Codex's interactive multiple-choice "ask the user" UI is not detected yet — its on-screen
// format hasn't been captured live, and guessing the footer/markers risks mis-navigation. Add a
// `detectQuestion` here (mirroring claude.ts / opencode.ts via parseChoiceList) once the real pane
// output is known; the rest of the pipeline (deriver → overseer 'question' decision) already works.
export function detectCodex(output: string): DetectedPrompt | null {
  return detectApproval(output);
}
