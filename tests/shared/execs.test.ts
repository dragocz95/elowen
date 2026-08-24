import { describe, it, expect } from 'vitest';
/** The brain providers this installation has configured. A brain exec only skips the global
 *  allow-list when its provider is one of these — see isOfferableExec. */
const PROVIDERS = ['x', 'any', 'relay', 'other', 'anthropic', 'oauth-anthropic', 'prov'];

import {
  PROGRAM_PREFIXES,
  DEFAULT_BINS,
  KNOWN_EXECS,
  parseElowenExec,
  elowenExec,
  isExecAllowedForUser,
  isModelVisibleForUser,
  EXEC_NOTES,
  isWellFormedExec,
  isAllowedExec,
} from '../../src/shared/execs.js';

describe('shared/execs', () => {
  it('maps every prefix to a program with a default-bin entry (elowen is binary-less by design)', () => {
    for (const program of Object.values(PROGRAM_PREFIXES)) {
      expect(DEFAULT_BINS[program]).toBe(program === 'elowen' ? '' : DEFAULT_BINS[program]);
      expect(program === 'elowen' ? true : !!DEFAULT_BINS[program]).toBe(true);
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

  describe('elowen exec specs', () => {
    it('round-trips provider/model through elowenExec + parseElowenExec', () => {
      expect(parseElowenExec(elowenExec('relay', 'kimi-k2.7'))).toEqual({ provider: 'relay', model: 'kimi-k2.7' });
    });
    it('splits on the FIRST slash so the model part may contain more', () => {
      expect(parseElowenExec('elowen:relay/ollama/kimi-k2.7-code')).toEqual({ provider: 'relay', model: 'ollama/kimi-k2.7-code' });
    });
    it('rejects malformed specs', () => {
      expect(parseElowenExec('elowen:relay')).toBeNull();
      expect(parseElowenExec('elowen:/model')).toBeNull();
      expect(parseElowenExec('elowen:relay/')).toBeNull();
      expect(parseElowenExec('codex:gpt-5.5')).toBeNull();
    });
    // Now that the bare `provider/model` shape belongs to the brain, this exported helper would read
    // ANOTHER program's spec as a brain identity on the strength of the slash alone — `opencode:` would
    // become the provider. parseExecRef never hands it such a value today, but the function is public
    // and its contract is "a brain exec or nothing". Mutation: drop the prefix check and this goes green
    // with { provider: 'opencode:vendor', model: 'model' }.
    it('refuses a spec that carries another program\'s prefix, slash or not', () => {
      expect(parseElowenExec('opencode:vendor/model')).toBeNull();
      expect(parseElowenExec('claude:some/model')).toBeNull();
      // …while the canonical unprefixed brain spelling is exactly what it does accept
      expect(parseElowenExec('relay/kimi')).toEqual({ provider: 'relay', model: 'kimi' });
    });
    it('routes the elowen: prefix to the elowen program', () => {
      expect(PROGRAM_PREFIXES['elowen:']).toBe('elowen');
    });
  });

  describe('isExecAllowedForUser', () => {
    const globalExecs = ['sonnet']; // the CLI global list; brain (elowen:) execs are NOT bounded by it
    it('admin and open mode are unrestricted', () => {
      expect(isExecAllowedForUser({ is_admin: true, allowed_execs: [] }, globalExecs, 'elowen:x/y', PROVIDERS)).toBe(true);
      expect(isExecAllowedForUser(null, globalExecs, 'elowen:x/y', PROVIDERS)).toBe(true);
    });
    it('CLI execs are bounded by the global list', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'opus', PROVIDERS)).toBe(false); // not global
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'sonnet', PROVIDERS)).toBe(true);
    });
    it('brain (elowen:) execs skip the global bound — empty personal list = every configured brain model', () => {
      // The reported bug: without this a non-admin gets an EMPTY brain-model picker.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'elowen:any/model', PROVIDERS)).toBe(true);
    });
    it('a non-empty personal list narrows further (CLI and brain alike)', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: ['elowen:relay/kimi'] }, globalExecs, 'elowen:other/m', PROVIDERS)).toBe(false);
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: ['elowen:relay/kimi'] }, globalExecs, 'elowen:relay/kimi', PROVIDERS)).toBe(true);
    });

    // The reported bug. `allowedExecs` is the CLI-agent list; a brain exec is bounded by the configured
    // PROVIDERS instead. But the old guard was one `&&`, so a brain exec whose provider had been deleted
    // failed the provider test and then got waved through by the stale `allowedExecs` entry the same
    // deletion left behind. Deleting the `alibaba` provider therefore changed nothing: `alibaba/…` stayed
    // allowed, stayed offered, and stayed storable. A brain exec must be judged by the live registry ALONE.
    it('refuses a brain exec whose provider is gone, even when allowedExecs still lists it', () => {
      const stale = ['sonnet', 'alibaba/qwen3.8-max'];
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, stale, 'alibaba/qwen3.8-max', PROVIDERS)).toBe(false);
      // …not even when the user's own whitelist names it, which is the shape the operator's DB is in.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: ['alibaba/qwen3.8-max'] }, stale, 'alibaba/qwen3.8-max', PROVIDERS)).toBe(false);
      // The legacy `elowen:` spelling is the same fact and must not be a way around it.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, ['elowen:alibaba/q'], 'elowen:alibaba/q', PROVIDERS)).toBe(false);
    });

    it('keeps admitting a brain exec whose provider is still configured', () => {
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, 'anthropic/claude-opus-5', PROVIDERS)).toBe(true);
    });
  });

  describe('isModelVisibleForUser (picker display filter)', () => {
    const globalExecs = ['sonnet']; // CLI global list; brain execs bounded by providers, not this
    it('a personal list narrows the picker (CLI and brain)', () => {
      expect(isModelVisibleForUser({ allowed_execs: ['sonnet'] }, globalExecs, 'elowen:relay/kimi', PROVIDERS)).toBe(false);
      expect(isModelVisibleForUser({ allowed_execs: ['sonnet'] }, globalExecs, 'sonnet', PROVIDERS)).toBe(true);
    });
    it('empty personal list = every configured brain model + the global CLI list', () => {
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, 'elowen:relay/kimi', PROVIDERS)).toBe(true); // brain not global-bounded
      expect(isModelVisibleForUser({ allowed_execs: [] }, globalExecs, 'opus', PROVIDERS)).toBe(false); // CLI not in global
    });
    it('null user = open mode (all global CLI + all brain)', () => {
      expect(isModelVisibleForUser(null, globalExecs, 'sonnet', PROVIDERS)).toBe(true);
      expect(isModelVisibleForUser(undefined, globalExecs, 'elowen:x/y', PROVIDERS)).toBe(true); // brain always visible in open mode
    });

    // The display point must reach the same verdict as the permission gate above — the whole symptom was a
    // picker offering something the runtime would refuse. Open mode is where a stale `allowedExecs` entry
    // did the most damage: with no user to narrow it, the dead model was simply offered to everyone.
    it('hides a brain exec whose provider is gone, in every mode', () => {
      const stale = ['sonnet', 'alibaba/qwen3.8-max'];
      expect(isModelVisibleForUser(null, stale, 'alibaba/qwen3.8-max', PROVIDERS)).toBe(false);
      expect(isModelVisibleForUser({ allowed_execs: [] }, stale, 'alibaba/qwen3.8-max', PROVIDERS)).toBe(false);
      expect(isModelVisibleForUser({ allowed_execs: ['alibaba/qwen3.8-max'] }, stale, 'alibaba/qwen3.8-max', PROVIDERS)).toBe(false);
    });
  });
});
