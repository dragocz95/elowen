import type { DetectedPrompt } from './types.js';
import { detectOpenCode } from './opencode.js';
import { detectClaude } from './claude.js';
import { detectCodex } from './codex.js';

export type { DetectedPrompt } from './types.js';

/** Detect an interactive prompt (permission gate or multiple-choice question) in an agent's captured
 *  pane, dispatched to the right provider module. Each CLI renders these differently, so the per-
 *  provider detectors live in their own files (opencode.ts / claude.ts / codex.ts) and only the
 *  shared list parsing is factored out (optionList.ts). Returns null when nothing is awaiting input. */
export function detectAgentPrompt(output: string, program: string): DetectedPrompt | null {
  const p = program.toLowerCase();
  if (p.startsWith('opencode')) return detectOpenCode(output);
  if (p.startsWith('claude')) return detectClaude(output);
  if (p.startsWith('codex')) return detectCodex(output);
  return null;
}
