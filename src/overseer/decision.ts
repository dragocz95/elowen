import type { InferenceClient } from '../inference/types.js';

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

// Operations that always escalate to a human, regardless of autonomy or LLM opinion.
const DESTRUCTIVE = /\brm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE\b|\bmigrat|\.env\b|secret|credential|password|private[_-]?key|force[- ]?push|git\s+reset\s+--hard|git\s+push\s+.*-f|chmod\s+777|curl[^|]*\|\s*(sh|bash)/i;

export function isDestructive(text: string): boolean {
  return DESTRUCTIVE.test(text);
}

export function decisionPrompt(input: PromptContext): string {
  const opts = input.options.map((o) => `- ${o.id}: ${o.label}`).join('\n');
  return [
    'You are the Overseer for an autonomous coding agent. An agent has paused on a prompt and needs a decision.',
    'Decide whether to APPROVE (let the agent proceed / accept) or ESCALATE to a human.',
    'Approve routine, safe, clearly-correct actions. Escalate anything destructive, ambiguous, or high-stakes.',
    'Return ONLY a JSON object (no prose, no fences):',
    '{"approve": boolean, "confidence": number (0..1), "destructive": boolean, "rationale": string}',
    '',
    `Autonomy level: ${input.autonomy}`,
    `Prompt: ${input.question}`,
    `Context: ${input.context}`,
    opts ? `Options:\n${opts}` : '',
  ].filter(Boolean).join('\n');
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
  return [
    'You are the Overseer for an autonomous coding mission. A task is about to be dispatched to an executor agent.',
    'It tripped one or more guardrails (sensitive areas). Decide whether to APPROVE the dispatch or ESCALATE to a human.',
    'Approve clearly-scoped, safe work. Escalate anything destructive, ambiguous, or that exceeds the task\'s stated intent.',
    'Return ONLY a JSON object (no prose, no fences):',
    '{"approve": boolean, "confidence": number (0..1), "destructive": boolean, "rationale": string}',
    '',
    `Autonomy level: ${input.autonomy}`,
    `Triggered guardrails: ${input.guardrails.join(', ') || 'none'}`,
    `Task: ${input.title}`,
    input.description ? `Details: ${input.description}` : '',
    input.labels.length ? `Labels: ${input.labels.join(', ')}` : '',
  ].filter(Boolean).join('\n');
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
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object in decision output');
  const raw = JSON.parse(match[0]) as Partial<Decision>;
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
