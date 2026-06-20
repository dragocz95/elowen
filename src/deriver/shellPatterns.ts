export interface DetectedPrompt {
  question: string;
  questionType: 'choice' | 'approval';
  options: { id: string; label: string }[];
  context: string;
  /** Keys that accept/approve the prompt. The deriver sends these only when autonomy permits. */
  acceptKeys: string[];
  /** Environmental gate (e.g. workspace-trust) the agent must clear just to start — not an action
   *  it wants to take. The deriver clears these directly under autonomy, without an overseer call:
   *  orca only ever spawns into projects the user registered, so trusting the workspace is implied. */
  autoAccept?: boolean;
}

const OPENCODE_PERMISSION = {
  title: 'Permission required',
  accept: ['Allow always', 'Always allow', 'Allow once', 'Allow'],
  reject: ['Reject', 'REJECT'],
} as const;

function detectOpenCodePermission(output: string): DetectedPrompt | null {
  const hasTitle = output.includes(OPENCODE_PERMISSION.title);
  const hasAccept = OPENCODE_PERMISSION.accept.some((p) => output.includes(p));
  const hasReject = OPENCODE_PERMISSION.reject.some((p) => output.includes(p));
  if (!(hasTitle && hasAccept && hasReject)) return null;
  return {
    question: 'OpenCode requests permission for an action.',
    questionType: 'choice',
    options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }],
    context: OPENCODE_PERMISSION.title,
    acceptKeys: ['Enter'], // leftmost "Allow once" is focused; one Enter approves (verified live)
  };
}

// Claude Code workspace-trust gate, shown on first entry to an unseen folder (even with
// --dangerously-skip-permissions, which only bypasses per-tool prompts). Blocks the agent from
// starting at all, so an autonomous mission would otherwise hang here forever. Default-highlighted
// option is "1. Yes, I trust this folder" → a single Enter confirms (verified live, claude 2.1.x).
function detectClaudeTrust(output: string): DetectedPrompt | null {
  if (!/Yes, I trust this folder/i.test(output)) return null;
  return {
    question: 'Claude asks to trust the workspace folder before starting.',
    questionType: 'approval',
    options: [{ id: 'yes', label: 'Yes, I trust this folder' }, { id: 'no', label: 'No, exit' }],
    context: 'Accessing workspace (trust check)',
    acceptKeys: ['Enter'],
    autoAccept: true,
  };
}

// Claude Code permission gate: "Do you want to proceed?" with "1. Yes" highlighted.
function detectClaudePermission(output: string): DetectedPrompt | null {
  if (!/Do you want to proceed\?/i.test(output)) return null;
  return {
    question: 'Claude requests permission to proceed.',
    questionType: 'approval',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    context: 'Do you want to proceed?',
    acceptKeys: ['Enter'], // default-highlighted option is "Yes"
  };
}

// Codex approval gate (when not run with --dangerously-bypass-approvals-and-sandbox).
function detectCodexApproval(output: string): DetectedPrompt | null {
  if (!/Allow command\?|Approve this command\?|Run command\?/i.test(output)) return null;
  return {
    question: 'Codex requests approval to run a command.',
    questionType: 'approval',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    context: 'Codex approval',
    acceptKeys: ['Enter'],
  };
}

export function detectAgentPrompt(output: string, program: string): DetectedPrompt | null {
  const p = program.toLowerCase();
  if (p.startsWith('opencode')) return detectOpenCodePermission(output);
  if (p.startsWith('claude')) return detectClaudeTrust(output) ?? detectClaudePermission(output);
  if (p.startsWith('codex')) return detectCodexApproval(output);
  return null;
}
