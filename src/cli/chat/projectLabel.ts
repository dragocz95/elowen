import { color } from './theme.js';
import type { BrainProjectWorkspaceView } from './brainClient.js';

export interface ProjectStatusInput {
  cwd: string;
  branch: string;
  /** The Sandbox workspace the daemon reports the conversation bound to, or null. */
  workspace: BrainProjectWorkspaceView | null;
}

/** The one-line project context the composer footer and the start screen share: the client's own cwd and
 *  branch, plus a faint `[S] <label>` when the daemon says the conversation is bound to a Sandbox
 *  workspace. The marker matters because the two then disagree — the client still sits in its directory
 *  while every Bash command of the conversation runs inside the worktree's container, with the worktree
 *  mounted at `/workspace` and no Git. `cwd`/`branch` stay the client's: they are what `/cd` moves. */
export function projectStatusLabel(input: ProjectStatusInput): string {
  const parts = [color.dim(input.cwd)];
  if (input.branch) parts.push(color.faint(input.branch));
  if (input.workspace) parts.push(color.faint(`[S] ${input.workspace.label}`));
  return parts.join(color.faint(' · '));
}
