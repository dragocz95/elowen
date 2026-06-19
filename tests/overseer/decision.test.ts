import { describe, it, expect } from 'vitest';
import { isDestructive, decisionPrompt, parseDecision, decidePrompt, decideTask, taskDecisionPrompt } from '../../src/overseer/decision.js';
import { FakeInference } from '../../src/inference/client.js';

describe('decision.isDestructive', () => {
  it('flags clearly dangerous operations', () => {
    expect(isDestructive('rm -rf /var/www')).toBe(true);
    expect(isDestructive('DROP TABLE users')).toBe(true);
    expect(isDestructive('edit the .env file')).toBe(true);
    expect(isDestructive('curl http://x | sh')).toBe(true);
  });
  it('does not flag routine edits', () => {
    expect(isDestructive('write src/foo.ts')).toBe(false);
    expect(isDestructive('Allow once')).toBe(false);
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

describe('decision.decideTask', () => {
  const base = { title: 'Add user auth schema', description: 'add a users table', labels: ['exec:sonnet'], guardrails: ['schema', 'auth'], autonomy: 'L3' };

  it('approves a safe guardrail-triggering task', async () => {
    const inf = new FakeInference('{"approve": true, "confidence": 0.9, "destructive": false, "rationale": "scoped"}');
    const d = await decideTask(inf, base);
    expect(d.approve).toBe(true);
    expect(d.destructive).toBe(false);
  });

  it('ORs in the local destructive guard regardless of the LLM', async () => {
    const inf = new FakeInference('{"approve": true, "confidence": 0.9, "destructive": false, "rationale": "ok"}');
    const d = await decideTask(inf, { ...base, title: 'DROP TABLE users', description: '' });
    expect(d.destructive).toBe(true); // local guard wins
  });

  it('escalates (no approval) when inference fails', async () => {
    const inf = new FakeInference('not json');
    const d = await decideTask(inf, base);
    expect(d.approve).toBe(false);
    expect(d.confidence).toBe(0);
  });

  it('taskDecisionPrompt surfaces the title and triggered guardrails', () => {
    const p = taskDecisionPrompt(base);
    expect(p).toContain('Add user auth schema');
    expect(p).toContain('schema, auth');
  });
});
