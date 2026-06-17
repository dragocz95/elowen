export interface DetectedPrompt {
  question: string;
  questionType: 'choice' | 'approval';
  options: { id: string; label: string }[];
  context: string;
  /** Set when a JAT autopilot agent should clear this permission gate itself. */
  autoApprove?: { keys: string[] };
}

const OPENCODE_PERMISSION = {
  title: 'Permission required',
  accept: ['Allow always', 'Always allow', 'Allow once', 'Allow'],
  reject: ['Reject', 'REJECT'],
} as const;

function detectOpenCodePermission(output: string): DetectedPrompt | null {
  const hasTitle = output.includes(OPENCODE_PERMISSION.title);
  const hasAccept = OPENCODE_PERMISSION.accept.some(p => output.includes(p));
  const hasReject = OPENCODE_PERMISSION.reject.some(p => output.includes(p));
  if (!(hasTitle && hasAccept && hasReject)) return null;
  return {
    question: 'OpenCode requests permission for an out-of-scope action.',
    questionType: 'choice',
    options: [{ id: 'allow', label: 'Allow always' }, { id: 'reject', label: 'Reject' }],
    context: OPENCODE_PERMISSION.title,
    // Default focus is the leftmost "Allow once"; one Enter approves (verified live).
    autoApprove: { keys: ['Enter'] },
  };
}

export function detectAgentPrompt(output: string, program: string): DetectedPrompt | null {
  if (program.toLowerCase().startsWith('opencode')) return detectOpenCodePermission(output);
  return null;
}
