import type { InferenceClient } from '../inference/types.js';
import { render } from '../prompts/index.js';
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
  destructive: boolean;
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
 *  autonomy (L3) may wave a non-destructive prompt through unattended; L0–L2 escalate to a human
 *  rather than be blindly approved. Destructive prompts always escalate, even at L3. */
export function noOverseerFallback(autonomy: string, destructive: boolean): { approve: boolean; destructive: boolean } {
  return { approve: autonomy === 'L3' && !destructive, destructive };
}

/** Apply the auto-approve gate to a raw decision/verdict: approve only when the overseer was
 *  confident enough (≥ `minConfidence`, default MIN_CONFIDENCE), and — for prompt-style decisions —
 *  only when not flagged destructive. The `destructive` flag always passes through so the caller can
 *  escalate on it. This is the single place the threshold is applied; callers no longer re-implement
 *  the comparison. Pass `minConfidence` (e.g. via `minConfidenceFor`) to raise the bar per autonomy. */
export function gateVerdict(
  v: { approve: boolean; confidence: number; destructive: boolean },
  opts: { blockDestructive: boolean; minConfidence?: number },
): { approve: boolean; destructive: boolean } {
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE;
  return {
    approve: v.approve && v.confidence >= minConfidence && (!opts.blockDestructive || !v.destructive),
    destructive: v.destructive,
  };
}

// Operations that always escalate to a human, regardless of autonomy or LLM opinion. Covers the
// common ways a model can fetch-and-execute or shell out — not just `curl | sh` (#45): wget piped to
// a shell, inline interpreter one-liners (python/node/perl -e/-c), netcat, and arbitrary-code sinks
// (eval/exec/os.system/subprocess) — so a reworded but equally dangerous command can't slip past.
const DESTRUCTIVE = /\brm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE\b|\bmigrat|\.env\b|secret|credential|password|private[_-]?key|force[- ]?push|git\s+reset\s+--hard|git\s+push\s+.*-f|chmod\s+777|(curl|wget)[^|]*\|\s*(sh|bash)|(python\d?|node|perl)\s+-[ce]\b|\b(ncat|nc)\s+-|bash\s+-c|\beval\s*\(|os\.system|subprocess\.|\bexec\s*\(/i;

export function isDestructive(text: string): boolean {
  return DESTRUCTIVE.test(text);
}

/** Shared overseer prompt header (role + approve/escalate instruction + JSON output contract). Both
 *  the prompt-gate and task-gate builders render this, then append their own context fields — one
 *  source of truth for the verdict format so the two prompts can't drift apart. */
function overseerHeader(subject: string, approveGuidance: string): string {
  return render('decision-header', { subject, approveGuidance });
}

export function decisionPrompt(input: PromptContext): string {
  const opts = input.options.map((o) => `- ${o.id}: ${o.label}`).join('\n');
  const header = overseerHeader('agent. An agent has paused on a prompt and needs a decision', 'Approve routine, safe, clearly-correct actions. Escalate anything destructive, ambiguous, or high-stakes.');
  const body = render('decision-prompt', {
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
    destructive: raw.destructive === true,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
  };
}

/**
 * Decide whether to auto-approve a paused agent prompt or escalate to a human.
 * A local destructive heuristic always wins (forces escalate) over the LLM's opinion.
 */
export async function decidePrompt(inf: InferenceClient, input: PromptContext): Promise<Decision> {
  const localDestructive = isDestructive(`${input.question} ${input.context}`);
  try {
    const { text } = await inf.decide(decisionPrompt(input));
    const d = parseDecision(text);
    return { ...d, destructive: d.destructive || localDestructive };
  } catch {
    // LLM unavailable/unparseable → be conservative: escalate, and respect the local guard.
    return { approve: false, confidence: 0, destructive: localDestructive, rationale: 'overseer inference failed' };
  }
}
