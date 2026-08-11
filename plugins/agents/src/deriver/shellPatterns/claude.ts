import type { DetectedPrompt } from './types.js';
import { parseChoiceList } from './optionList.js';

// Claude Code workspace-trust gate, shown on first entry to an unseen folder (even with
// --dangerously-skip-permissions, which only bypasses per-tool prompts). Blocks the agent from
// starting at all, so an autonomous mission would otherwise hang here forever. Default-highlighted
// option is "1. Yes, I trust this folder" → a single Enter confirms (verified live, claude 2.1.x).
function detectTrust(output: string): DetectedPrompt | null {
  if (!/Yes, I trust this folder/i.test(output)) return null;
  return {
    question: 'Claude asks to trust the workspace folder before starting.',
    options: [{ id: 'yes', label: 'Yes, I trust this folder' }, { id: 'no', label: 'No, exit' }],
    context: 'Accessing workspace (trust check)',
    acceptKeys: ['Enter'],
    autoAccept: true,
  };
}

// Claude Code permission gate: "Do you want to proceed?" with "1. Yes" highlighted.
function detectPermission(output: string): DetectedPrompt | null {
  if (!/Do you want to proceed\?/i.test(output)) return null;
  return {
    question: 'Claude requests permission to proceed.',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    context: 'Do you want to proceed?',
    acceptKeys: ['Enter'], // default-highlighted option is "Yes"
  };
}

// Claude Code's AskUserQuestion tool. Footer: "Enter to select · ↑/↓ to navigate · Esc to cancel"
// (distinct from the trust/permission gates' "Enter to confirm"). Claude always appends two
// escape-hatch options — "Type something." and "Chat about this" — which we drop so the overseer
// only ever picks a real canned answer; otherwise it escalates to a human.
function detectQuestion(output: string): DetectedPrompt | null {
  const parsed = parseChoiceList(output, /enter to select/i, /^(type something|chat about)/i);
  if (!parsed) return null;
  return {
    question: parsed.question || 'Claude asks you to choose an option.',
    options: parsed.options,
    context: 'Claude question',
    acceptKeys: ['Enter'],
    kind: 'choice',
  };
}

export function detectClaude(output: string): DetectedPrompt | null {
  return detectTrust(output) ?? detectPermission(output) ?? detectQuestion(output);
}
