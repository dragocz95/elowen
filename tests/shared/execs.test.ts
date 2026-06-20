import { describe, it, expect } from 'vitest';
import {
  PROGRAM_PREFIXES,
  DEFAULT_BINS,
  KNOWN_EXECS,
  isWellFormedExec,
  isAllowedExec,
} from '../../src/shared/execs.js';

describe('shared/execs', () => {
  it('maps every prefix to a program that has a default bin', () => {
    for (const program of Object.values(PROGRAM_PREFIXES)) {
      expect(DEFAULT_BINS[program]).toBeTruthy();
    }
  });

  it('KNOWN_EXECS is the built-in allow-list', () => {
    expect(KNOWN_EXECS).toContain('sonnet');
    expect(KNOWN_EXECS).toContain('codex:gpt-5.4');
    expect(KNOWN_EXECS.length).toBe(5);
  });

  describe('isWellFormedExec', () => {
    it('accepts explicit program prefixes', () => {
      expect(isWellFormedExec('codex:gpt-5.4')).toBe(true);
      expect(isWellFormedExec('opencode:deepseek/deepseek-v4-flash')).toBe(true);
      expect(isWellFormedExec('claude:opus')).toBe(true);
    });
    it('accepts provider/model slash shape', () => {
      expect(isWellFormedExec('deepseek/deepseek-v4-flash')).toBe(true);
    });
    it('rejects a bare plain spec', () => {
      expect(isWellFormedExec('foo')).toBe(false);
      expect(isWellFormedExec('sonnet')).toBe(false);
    });
  });

  describe('isAllowedExec', () => {
    const allowed = ['sonnet', 'codex:gpt-5.4'];
    it('treats empty string as unset (acceptable)', () => {
      expect(isAllowedExec('', allowed)).toBe(true);
    });
    it('accepts an allow-listed bare spec', () => {
      expect(isAllowedExec('sonnet', allowed)).toBe(true);
    });
    it('accepts a well-formed spec even when not allow-listed', () => {
      expect(isAllowedExec('claude:opus', allowed)).toBe(true);
      expect(isAllowedExec('opencode:deepseek/deepseek-v4-flash', allowed)).toBe(true);
    });
    it('rejects a bare bogus spec that is not allow-listed', () => {
      expect(isAllowedExec('foo', allowed)).toBe(false);
    });
  });
});
