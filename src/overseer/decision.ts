import type { InferenceClient } from '../inference/types.js';
import { render } from '../prompts/index.js';
import type { RenderPrompt } from '../spawn/commandBuilder.js';
import { extractJson } from './llmParse.js';

export interface PromptContext {
  question: string;
  context: string;
  options: { id: string; label: string }[];
  autonomy: string;
}

export interface Decision {
  approve: boolean;
  /** 0..1 — how sure the overseer is. Low confidence escalates. */
  confidence: number;
  rationale: string;
}

/** Minimum overseer confidence to auto-approve a decision; below this the action escalates to a
 *  human. Single source of truth for both the prompt gate (deriver) and the task gate (engine). */
export const MIN_CONFIDENCE = 0.6;

/** Stricter confidence bar for L1 (Assist): the Pilot may auto-run only *clearly* safe steps, so a
 *  merely-plausible verdict is not enough — anything below this escalates to a human. */
export const STRICT_CONFIDENCE = 0.85;

/** The confidence an overseer verdict must reach to auto-clear at a given autonomy level. L1 (Assist)
 *  is held to a stricter bar than L2/L3, which is exactly what separates "only safe steps" from
 *  "clears prompts itself". Single source of truth for the per-level threshold. */
export function minConfidenceFor(autonomy: string): number {
  return autonomy === 'L1' ? STRICT_CONFIDENCE : MIN_CONFIDENCE;
}

/** The decision when no overseer is configured at all (relay fallback, no parked agent). Only full
 *  autonomy (L3) may wave a prompt through unattended; L0–L2 escalate to a human rather than be
 *  blindly approved. */
export function noOverseerFallback(autonomy: string): { approve: boolean } {
  return { approve: autonomy === 'L3' };
}

/** Apply the auto-approve gate to a raw decision/verdict: approve only when the overseer was
 *  confident enough (≥ `minConfidence`, default MIN_CONFIDENCE). This is the single place the
 *  threshold is applied; callers no longer re-implement the comparison. Pass `minConfidence`
 *  (e.g. via `minConfidenceFor`) to raise the bar per autonomy. */
export function gateVerdict(
  v: { approve: boolean; confidence: number },
  opts: { minConfidence?: number },
): { approve: boolean } {
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE;
  return { approve: v.approve && v.confidence >= minConfidence };
}

/** Shared overseer prompt header (role + approve/escalate instruction + JSON output contract). Both
 *  the prompt-gate and task-gate builders render this, then append their own context fields — one
 *  source of truth for the verdict format so the two prompts can't drift apart. */
function overseerHeader(subject: string, approveGuidance: string, renderPrompt: RenderPrompt = render): string {
  return renderPrompt('decision-header', { subject, approveGuidance });
}

export function decisionPrompt(input: PromptContext, renderPrompt: RenderPrompt = render): string {
  const opts = input.options.map((o) => `- ${o.id}: ${o.label}`).join('\n');
  const header = overseerHeader('agent. An agent has paused on a prompt and needs a decision', 'Approve routine, safe, clearly-correct actions. Escalate anything destructive, ambiguous, or high-stakes.', renderPrompt);
  const body = renderPrompt('decision-prompt', {
    autonomy: input.autonomy,
    question: input.question,
    context: input.context,
    options: opts ? `\nOptions:\n${opts}` : '',
  });
  return `${header}\n${body}`;
}

export function parseDecision(text: string): Decision {
  const raw = extractJson(text, '{') as Partial<Decision>; // first balanced object; callers wrap in try/catch
  return {
    approve: raw.approve === true,
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
  };
}

/** Decide whether to auto-approve a paused agent prompt or escalate to a human. */
export async function decidePrompt(inf: InferenceClient, input: PromptContext, renderPrompt: RenderPrompt = render): Promise<Decision> {
  try {
    const { text } = await inf.decide(decisionPrompt(input, renderPrompt));
    return parseDecision(text);
  } catch {
    // LLM unavailable/unparseable → be conservative: escalate.
    return { approve: false, confidence: 0, rationale: 'overseer inference failed' };
  }
}

// --- Multiple-choice questions (the agent's "ask the user" tool) ------------------------------
// Distinct from a permission gate: instead of approve/reject, the overseer picks ONE of the agent's
// canned options (or escalates). The chosen id is the option's list position, which the deriver turns
// into keyboard navigation. Same confidence gate as prompts — a low-confidence pick escalates.

export interface ChoiceContext {
  question: string;
  context: string;
  options: { id: string; label: string }[];
  autonomy: string;
}

export interface ChoiceVerdict {
  /** The picked option id, or 'escalate' to hand the question to a human. */
  choice: string;
  /** 0..1 — how sure the overseer is. Below the autonomy bar it escalates. */
  confidence: number;
  rationale: string;
}

export function choicePrompt(input: ChoiceContext, renderPrompt: RenderPrompt = render): string {
  const opts = input.options.map((o) => `- ${o.id}: ${o.label}`).join('\n');
  return renderPrompt('decision-question', {
    autonomy: input.autonomy,
    question: input.question,
    context: input.context,
    options: opts,
  });
}

export function parseChoice(text: string): ChoiceVerdict {
  const raw = extractJson(text, '{') as Partial<ChoiceVerdict>; // first balanced object; wrapped in try/catch
  return {
    choice: typeof raw.choice === 'string' ? raw.choice : 'escalate',
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
  };
}

/** Ask the overseer to pick one of the agent's options. On any inference/parse failure it escalates
 *  (choice 'escalate', confidence 0) — the deriver then routes the question to a human. */
export async function decideChoice(inf: InferenceClient, input: ChoiceContext, renderPrompt: RenderPrompt = render): Promise<ChoiceVerdict> {
  try {
    const { text } = await inf.decide(choicePrompt(input, renderPrompt));
    return parseChoice(text);
  } catch {
    return { choice: 'escalate', confidence: 0, rationale: 'overseer inference failed' };
  }
}
