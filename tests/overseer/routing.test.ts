import { describe, it, expect } from 'vitest';
import { resolveExecutor } from '../../src/overseer/routing.js';
import { BARE_WITH_SLASH_PROGRAM, BARE_PLAIN_PROGRAM, PROGRAM_PREFIXES } from '../../src/shared/execs.js';

const FB = { program: 'claude-code', model: 'sonnet' };
describe('resolveExecutor', () => {
  it('routes exec:provider/model to opencode', () => {
    expect(resolveExecutor(['exec:ollama-cloud/deepseek-v4-flash'], FB)).toEqual({ program: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' });
  });
  it('routes bare exec:sonnet to claude', () => {
    expect(resolveExecutor(['exec:sonnet'], FB)).toEqual({ program: 'claude-code', model: 'sonnet' });
  });
  it('routes explicit exec:codex:<model> to codex', () => {
    expect(resolveExecutor(['exec:codex:gpt-5.4'], FB)).toEqual({ program: 'codex', model: 'gpt-5.4' });
  });
  it('falls back when no exec label', () => {
    expect(resolveExecutor(['type:bug'], FB)).toEqual(FB);
  });
  it('resolves every shared prefix to its mapped program', () => {
    for (const [prefix, program] of Object.entries(PROGRAM_PREFIXES)) {
      expect(resolveExecutor([`exec:${prefix}m`], FB)).toEqual({ program, model: 'm' });
    }
  });
  it('bare-spec fallbacks match the shared constants (single source of truth)', () => {
    expect(resolveExecutor(['exec:a/b'], FB).program).toBe(BARE_WITH_SLASH_PROGRAM);
    expect(resolveExecutor(['exec:plain'], FB).program).toBe(BARE_PLAIN_PROGRAM);
  });
});
