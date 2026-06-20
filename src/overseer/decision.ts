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

/** Apply the auto-approve gate to a raw decision/verdict: approve only when the overseer was
 *  confident enough (≥ MIN_CONFIDENCE), and — for prompt-style decisions — only when not flagged
 *  destructive. The `destructive` flag always passes through so the caller can escalate on it. This
 *  is the single place the threshold is applied; callers no longer re-implement the comparison. */
export function gateVerdict(
  v: { approve: boolean; confidence: number; destructive: boolean },
  opts: { blockDestructive: boolean },
): { approve: boolean; destructive: boolean } {
  return {
    approve: v.approve && v.confidence >= MIN_CONFIDENCE && (!opts.blockDestructive || !v.destructive),
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

export interface TaskContext {
  title: string;
  description: string;
  labels: string[];
  /** Guardrails the task tripped (schema, auth, payments, …) — why it reached the overseer. */
  guardrails: string[];
  autonomy: string;
}

export function taskDecisionPrompt(input: TaskContext): string {
  const header = overseerHeader('mission. A task is about to be dispatched to an executor agent. It tripped one or more guardrails (sensitive areas)', 'Approve clearly-scoped, safe work. Escalate anything destructive, ambiguous, or that exceeds the task\'s stated intent.');
  const body = render('decision-task', {
    autonomy: input.autonomy,
    guardrails: input.guardrails.join(', ') || 'none',
    title: input.title,
    details: input.description ? `\nDetails: ${input.description}` : '',
    labels: input.labels.length ? `\nLabels: ${input.labels.join(', ')}` : '',
  });
  return `${header}\n${body}`;
}

/**
 * Decide whether to dispatch a guardrail-triggering task or escalate to a human.
 * Mirrors {@link decidePrompt}: the local destructive heuristic always forces escalate,
 * and any inference failure is conservative (no approval).
 */
export async function decideTask(inf: InferenceClient, input: TaskContext): Promise<Decision> {
  const localDestructive = isDestructive(`${input.title} ${input.description}`);
  try {
    const { text } = await inf.decide(taskDecisionPrompt(input));
    const d = parseDecision(text);
    return { ...d, destructive: d.destructive || localDestructive };
  } catch {
    return { approve: false, confidence: 0, destructive: localDestructive, rationale: 'overseer inference failed' };
  }
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
