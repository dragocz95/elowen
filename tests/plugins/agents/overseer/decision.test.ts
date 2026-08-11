import { describe, it, expect } from 'vitest';
import { render } from '../../../../src/prompts/index.js';
import { decisionPrompt as rawDecisionPrompt, parseDecision, decidePrompt as rawDecidePrompt, gateVerdict, minConfidenceFor, noOverseerFallback, decideChoice as rawDecideChoice, choicePrompt as rawChoicePrompt, parseChoice, MIN_CONFIDENCE, STRICT_CONFIDENCE } from '../../../../plugins/agents/src/overseer/decision.js';

// The plugin functions take the prompt renderer as a REQUIRED seam (ctx.host.prompts in
// production); the core file renderer stands in here, matching the pre-extraction defaults.
const decisionPrompt = (input: Parameters<typeof rawDecisionPrompt>[0]) => rawDecisionPrompt(input, render);
const decidePrompt = (inf: Parameters<typeof rawDecidePrompt>[0], input: Parameters<typeof rawDecidePrompt>[1]) => rawDecidePrompt(inf, input, render);
const choicePrompt = (input: Parameters<typeof rawChoicePrompt>[0]) => rawChoicePrompt(input, render);
const decideChoice = (inf: Parameters<typeof rawDecideChoice>[0], input: Parameters<typeof rawDecideChoice>[1]) => rawDecideChoice(inf, input, render);
import { FakeInference } from '../../../../src/inference/client.js';

describe('decision.gateVerdict', () => {
  const v = (approve: boolean, confidence: number) => ({ approve, confidence });
  it('approves only at/above the confidence threshold', () => {
    expect(gateVerdict(v(true, MIN_CONFIDENCE), {}).approve).toBe(true);
    expect(gateVerdict(v(true, MIN_CONFIDENCE - 0.01), {}).approve).toBe(false);
    expect(gateVerdict(v(false, 1), {}).approve).toBe(false);
  });
  it('honours a custom minConfidence: a mid-confidence verdict clears the default gate but not a stricter one', () => {
    const mid = v(true, 0.7);
    expect(gateVerdict(mid, {}).approve).toBe(true); // default 0.6
    expect(gateVerdict(mid, { minConfidence: STRICT_CONFIDENCE }).approve).toBe(false); // 0.85
  });
});

describe('decision.minConfidenceFor', () => {
  it('L1 (Assist) demands a stricter confidence than L2/L3', () => {
    expect(minConfidenceFor('L1')).toBe(STRICT_CONFIDENCE);
    expect(minConfidenceFor('L1')).toBeGreaterThan(minConfidenceFor('L2'));
    expect(minConfidenceFor('L2')).toBe(MIN_CONFIDENCE);
    expect(minConfidenceFor('L3')).toBe(MIN_CONFIDENCE);
  });
});

describe('decision.noOverseerFallback', () => {
  it('only L3 blanket-approves a prompt when no overseer is configured', () => {
    expect(noOverseerFallback('L3')).toEqual({ approve: true });
    expect(noOverseerFallback('L2')).toEqual({ approve: false }); // escalates, not waved through
    expect(noOverseerFallback('L1')).toEqual({ approve: false });
  });
});

describe('decision.parseDecision', () => {
  it('parses and clamps the decision JSON', () => {
    const d = parseDecision('sure: {"approve": true, "confidence": 1.5, "rationale": "ok"}');
    expect(d.approve).toBe(true);
    expect(d.confidence).toBe(1); // clamped
  });
  it('throws on no JSON', () => {
    expect(() => parseDecision('no json here')).toThrow();
  });
  it('extracts the first balanced object, ignoring a trailing braced note (#46)', () => {
    const d = parseDecision('Verdict: {"approve": true, "confidence": 0.8, "rationale": "ok"}. {extra: noise}');
    expect(d.approve).toBe(true);
    expect(d.confidence).toBe(0.8);
  });
  it('tolerates braces inside string values', () => {
    const d = parseDecision('{"approve": false, "confidence": 0.4, "rationale": "uses } and { chars"}');
    expect(d.rationale).toBe('uses } and { chars');
  });
});

describe('decision.parseChoice', () => {
  it('parses and clamps the choice JSON', () => {
    const v = parseChoice('pick: {"choice": "2", "confidence": 1.4, "rationale": "best fit"}');
    expect(v.choice).toBe('2');
    expect(v.confidence).toBe(1); // clamped to [0,1]
    expect(v.rationale).toBe('best fit');
  });
  it('defaults missing/invalid fields to escalate + zero confidence', () => {
    const v = parseChoice('{"rationale": "unsure"}');
    expect(v.choice).toBe('escalate');
    expect(v.confidence).toBe(0);
  });
  it('throws on no JSON (decideChoice then escalates around it)', () => {
    expect(() => parseChoice('no json here')).toThrow();
  });
});

describe('decision.decidePrompt', () => {
  it('returns the LLM decision verbatim', async () => {
    const inf = new FakeInference('{"approve": true, "confidence": 0.9, "rationale": "safe edit"}');
    const d = await decidePrompt(inf, { question: 'Allow editing the config file?', context: 'config', options: [], autonomy: 'L3' });
    expect(d.approve).toBe(true);
    expect(d.confidence).toBe(0.9);
  });
  it('escalates when inference output is unparseable', async () => {
    const inf = new FakeInference('garbage');
    const d = await decidePrompt(inf, { question: 'Proceed?', context: 'ok', options: [], autonomy: 'L3' });
    expect(d.approve).toBe(false);
  });

  it('decisionPrompt includes the question and options', () => {
    const p = decisionPrompt({ question: 'Run build?', context: 'npm run build', options: [{ id: 'yes', label: 'Yes' }], autonomy: 'L2' });
    expect(p).toContain('Run build?');
    expect(p).toContain('yes: Yes');
  });
});

describe('decision.decideChoice', () => {
  const opts = [{ id: '1', label: ':4500 (uprav package.json)' }, { id: '2', label: ':4500 (uprav README)' }];
  it('returns the picked option id and confidence', async () => {
    const inf = new FakeInference('{"choice": "2", "confidence": 0.9, "rationale": "docs-only, no runtime change"}');
    const v = await decideChoice(inf, { question: 'which port?', context: 'docs', options: opts, autonomy: 'L3' });
    expect(v.choice).toBe('2');
    expect(v.confidence).toBe(0.9);
  });
  it('escalates (choice=escalate, confidence 0) when inference output is unparseable', async () => {
    const inf = new FakeInference('no json');
    const v = await decideChoice(inf, { question: 'which port?', context: 'docs', options: opts, autonomy: 'L3' });
    expect(v.choice).toBe('escalate');
    expect(v.confidence).toBe(0);
  });
  it('choicePrompt lists the option ids/labels and the question', () => {
    const p = choicePrompt({ question: 'which port?', context: 'docs', options: opts, autonomy: 'L2' });
    expect(p).toContain('which port?');
    expect(p).toContain('- 1: :4500 (uprav package.json)');
    expect(p).toContain('- 2: :4500 (uprav README)');
  });
});
