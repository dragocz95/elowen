import { describe, it, expect } from 'vitest';
import {
  PROGRAM_PREFIXES,
  DEFAULT_BINS,
  KNOWN_EXECS,
  parseOrcaExec,
  orcaExec,
  isExecAllowedForUser,
  isModelVisibleForUser,
  EXEC_NOTES,
  isWellFormedExec,
  isAllowedExec,
} from '../../src/shared/execs.js';

describe('shared/execs', () => {
  it('maps every prefix to a program with a default-bin entry (orca is binary-less by design)', () => {
    for (const program of Object.values(PROGRAM_PREFIXES)) {
      expect(DEFAULT_BINS[program]).toBe(program === 'orca' ? '' : DEFAULT_BINS[program]);
      expect(program === 'orca' ? true : !!DEFAULT_BINS[program]).toBe(true);
    }
  });

  it('registers the new agent CLI prefixes and bins (kilo/pi/omp)', () => {
    expect(PROGRAM_PREFIXES['kilo:']).toBe('kilo');
    expect(PROGRAM_PREFIXES['pi:']).toBe('pi');
    expect(PROGRAM_PREFIXES['omp:']).toBe('omp');
    expect(DEFAULT_BINS['kilo']).toBe('kilo');
    expect(DEFAULT_BINS['pi']).toBe('pi');
    expect(DEFAULT_BINS['omp']).toBe('omp');
  });

  it('treats prefixed new-CLI execs as well-formed (so they pass the allow-list guard)', () => {
    expect(isWellFormedExec('kilo:anthropic/claude-sonnet-4-5')).toBe(true);
    expect(isWellFormedExec('pi:sonnet')).toBe(true);
    expect(isWellFormedExec('omp:opus')).toBe(true);
  });

  it('KNOWN_EXECS is the built-in allow-list', () => {
    expect(KNOWN_EXECS).toContain('sonnet');
    expect(KNOWN_EXECS).toContain('opus');
    expect(KNOWN_EXECS).toContain('codex:gpt-5.5');
    expect(KNOWN_EXECS.length).toBe(11);
  });

  it('EXEC_NOTES describes every built-in exec', () => {
    for (const exec of KNOWN_EXECS) {
      expect(typeof EXEC_NOTES[exec]).toBe('string');
      expect(EXEC_NOTES[exec].length).toBeGreaterThan(0);
    }
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

  describe('orca exec specs', () => {
    it('round-trips provider/model through orcaExec + parseOrcaExec', () => {
      expect(parseOrcaExec(orcaExec('relay', 'kimi-k2.7'))).toEqual({ provider: 'relay', model: 'kimi-k2.7' });
    });
    it('splits on the FIRST slash so the model part may contain more', () => {
      expect(parseOrcaExec('orca:relay/ollama/kimi-k2.7-code')).toEqual({ provider: 'relay', model: 'ollama/kimi-k2.7-code' });
    });
    it('rejects malformed specs', () => {
      expect(parseOrcaExec('orca:relay')).toBeNull();
      expect(parseOrcaExec('orca:/model')).toBeNull();
      expect(parseOrcaExec('orca:relay/')).toBeNull();
      expect(parseOrcaExec('codex:gpt-5.5')).toBeNull();
    });
    it('routes the orca: prefix to the orca program', () => {
      expect(PROGRAM_PREFIXES['orca:']).toBe('orca');
    });
  });

  describe('isExecAllowedForUser', () => {
    const globalExecs = ['sonnet']; // the CLI global list; brain (orca:) execs are NOT bounded by it
    it('admin and open mode are unrestricted', () => {
      expect(isExecAllowedForUser({ is_admin: true, allowed_execs: [] }, globalExecs, 'orca:x/y')).toBe(true);
      expect(isExecAllowedForUser(null, globalExecs, 'orca:x/y')).toBe(true);
    });
    it('CLI execs are bounded by the global list', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'opus')).toBe(false); // not global
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'sonnet')).toBe(true);
    });
    it('brain (orca:) execs skip the global bound — empty personal list = every configured brain model', () => {
      // The reported bug: without this a non-admin gets an EMPTY brain-model picker.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'orca:any/model')).toBe(true);
    });
    it('a non-empty personal list narrows further (CLI and brain alike)', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: ['orca:relay/kimi'] }, globalExecs, 'orca:other/m')).toBe(false);
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: ['orca:relay/kimi'] }, globalExecs, 'orca:relay/kimi')).toBe(true);
    });
  });

  describe('isModelVisibleForUser (picker display filter)', () => {
    const globalExecs = ['sonnet']; // CLI global list; brain execs bounded by providers, not this
    it('a personal list narrows the picker (CLI and brain)', () => {
      expect(isModelVisibleForUser({ allowed_execs: ['sonnet'] }, globalExecs, 'orca:relay/kimi')).toBe(false);
      expect(isModelVisibleForUser({ allowed_execs: ['sonnet'] }, globalExecs, 'sonnet')).toBe(true);
    });
    it('empty personal list = every configured brain model + the global CLI list', () => {
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, 'orca:relay/kimi')).toBe(true); // brain not global-bounded
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, 'opus')).toBe(false); // CLI not in global
    });
    it('null user = open mode (all global CLI + all brain)', () => {
      expect(isModelVisibleForUser(null, globalExecs, 'sonnet')).toBe(true);
      expect(isModelVisibleForUser(undefined, globalExecs, 'orca:x/y')).toBe(true); // brain always visible in open mode
    });
  });
});
