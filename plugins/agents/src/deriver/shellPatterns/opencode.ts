import type { DetectedPrompt } from './types.js';
import { parseChoiceList } from './optionList.js';

const OPENCODE_PERMISSION = {
  title: 'Permission required',
  accept: ['Allow always', 'Always allow', 'Allow once', 'Allow'],
  reject: ['Reject', 'REJECT'],
} as const;

function detectPermission(output: string): DetectedPrompt | null {
  const hasTitle = output.includes(OPENCODE_PERMISSION.title);
  const hasAccept = OPENCODE_PERMISSION.accept.some((p) => output.includes(p));
  const hasReject = OPENCODE_PERMISSION.reject.some((p) => output.includes(p));
  if (!(hasTitle && hasAccept && hasReject)) return null;
  return {
    question: 'OpenCode requests permission for an action.',
    options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }],
    context: OPENCODE_PERMISSION.title,
    acceptKeys: ['Enter'], // leftmost "Allow once" is focused; one Enter approves (verified live)
  };
}

// OpenCode's "ask the user" list UI. Its footer reads "↑↓ select  enter submit  esc dismiss" — the
// "enter submit" token distinguishes it from the permission dialog ("enter confirm"). The trailing
// "Type your own answer" freeform entry is dropped: the overseer picks among canned options; a
// freeform answer is a human's to write (it escalates instead).
function detectQuestion(output: string): DetectedPrompt | null {
  const parsed = parseChoiceList(output, /enter submit/i, /^type your own/i);
  if (!parsed) return null;
  return {
    question: parsed.question || 'OpenCode asks you to choose an option.',
    options: parsed.options,
    context: 'OpenCode question',
    acceptKeys: ['Enter'],
    kind: 'choice',
  };
}

export function detectOpenCode(output: string): DetectedPrompt | null {
  return detectPermission(output) ?? detectQuestion(output);
}
