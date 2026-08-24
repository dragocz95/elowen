import { describe, it, expect } from 'vitest';
/** The brain providers this installation has configured. A brain exec only skips the global
 *  allow-list when its provider is one of these — see isOfferableExec. An EMPTY `models` list means the
 *  provider serves a live catalogue, so it bounds nothing beyond the provider itself; the whitelist
 *  behaviour of a NON-empty list has its own fixture below. */
const PROVIDERS = ['x', 'any', 'relay', 'other', 'anthropic', 'oauth-anthropic', 'prov']
  .map((id) => ({ id, models: [] as string[] }));

import {
  PROGRAM_PREFIXES,
  DEFAULT_BINS,
  KNOWN_EXECS,
  parseElowenExec,
  elowenExec,
  isExecAllowedForUser,
  isModelVisibleForUser,
  isOfferableBrainModel,
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

  // The model-level half of the same staleness: removing ONE model from a provider that still exists left
  // that model offered, grantable and storable, because the bound stopped at the provider id. A manual
  // model list is durable configuration (no upstream fetch can empty it), so it is a whitelist.
  describe('isOfferableBrainModel (manual model list = whitelist)', () => {
    // Mirrors the reporting instance: every provider carries an explicit list, and two of the model ids
    // contain slashes of their own — which is why membership is tested against the parsed model, never
    // against a naive split of the exec string.
    const CONFIGURED = [
      { id: 'ai-coresynth-io', models: ['deepseek/deepseek-v4-flash-vision-exp', 'sarah-nano'] },
      { id: 'kimi-coding', models: ['k3'] },
      { id: 'openrouter', models: ['openrouter/free'] },
      { id: 'catalogue', models: [] as string[] },
    ];

    it('accepts a model on the provider list, slashes in the model id included', () => {
      expect(isOfferableBrainModel('ai-coresynth-io', 'deepseek/deepseek-v4-flash-vision-exp', CONFIGURED)).toBe(true);
      expect(isOfferableBrainModel('openrouter', 'openrouter/free', CONFIGURED)).toBe(true);
      expect(isOfferableBrainModel('kimi-coding', 'k3', CONFIGURED)).toBe(true);
    });

    it('refuses a model the provider no longer lists', () => {
      // The operator's own case: he calls this one "K3", and a bare model-name match would have kept it.
      expect(isOfferableBrainModel('ai-coresynth-io', 'kimi-k3', CONFIGURED)).toBe(false);
      expect(isOfferableBrainModel('ai-coresynth-io', 'ollama/deepseek-v4-flash', CONFIGURED)).toBe(false);
      // …while the LIVE model of the same bare name on another provider survives untouched.
      expect(isOfferableBrainModel('kimi-coding', 'k3', CONFIGURED)).toBe(true);
    });

    it('an empty model list is a live catalogue, not an empty whitelist', () => {
      // The outage rule. A provider whose models come from an HTTP fetch must keep admitting them: the
      // fetch degrades to [] when the upstream is down, and denying everything then would lock the
      // instance out of its own models. Mutation: make an empty list deny and this goes red.
      expect(isOfferableBrainModel('catalogue', 'anything-at-all', CONFIGURED)).toBe(true);
      expect(isOfferableBrainModel('catalogue', 'vendor/nested/model', CONFIGURED)).toBe(true);
    });

    it('an unconfigured provider is still refused whatever the model', () => {
      expect(isOfferableBrainModel('alibaba', 'qwen3.8-max', CONFIGURED)).toBe(false);
    });

    it('the permission gate and the picker both apply it', () => {
      const globalExecs = ['sonnet'];
      const bob = { is_admin: false, allowed_execs: [] };
      expect(isExecAllowedForUser(bob, globalExecs, 'ai-coresynth-io/kimi-k3', CONFIGURED)).toBe(false);
      expect(isModelVisibleForUser(null, globalExecs, 'ai-coresynth-io/kimi-k3', CONFIGURED)).toBe(false);
      // A personal grant does not resurrect it — the same rule the provider-level fix established.
      expect(isExecAllowedForUser({ is_admin: false, allowed_execs: ['ai-coresynth-io/kimi-k3'] }, globalExecs, 'ai-coresynth-io/kimi-k3', CONFIGURED)).toBe(false);
      expect(isModelVisibleForUser({ allowed_execs: ['ai-coresynth-io/kimi-k3'] }, globalExecs, 'ai-coresynth-io/kimi-k3', CONFIGURED)).toBe(false);
      // The live one on the same provider stays available.
      expect(isExecAllowedForUser(bob, globalExecs, 'ai-coresynth-io/deepseek/deepseek-v4-flash-vision-exp', CONFIGURED)).toBe(true);
      expect(isModelVisibleForUser(null, globalExecs, 'ai-coresynth-io/deepseek/deepseek-v4-flash-vision-exp', CONFIGURED)).toBe(true);
    });

    // Existence is not a permission. The admin bypass answers "may this user be narrowed?", and the
    // answer for an admin is no — but a model this installation does not have cannot be run by anyone,
    // which is what makes a run PINNED to a dead model refuse instead of resolving. Without this the
    // operator (an admin) kept every dead model runnable through a stored session pin, a project
    // preference or /model, no matter what the picker showed. The CLI half of the bypass is untouched:
    // `allowedExecs` is the operator's own list and an admin may still step outside it.
    it('refuses a dead brain model even for an admin, while leaving the CLI bypass intact', () => {
      const admin = { is_admin: true, allowed_execs: [] };
      expect(isExecAllowedForUser(admin, ['sonnet'], 'ai-coresynth-io/kimi-k3', CONFIGURED)).toBe(false);
      expect(isExecAllowedForUser(admin, ['sonnet'], 'ai-coresynth-io/sarah-nano', CONFIGURED)).toBe(true);
      // An exec naming no provider at all is not a brain model reference and cannot become one.
      expect(isExecAllowedForUser(admin, ['sonnet'], '/kimi-k3', CONFIGURED)).toBe(false);
      // A CLI exec outside the global list still passes for an admin — unchanged.
      expect(isExecAllowedForUser(admin, ['sonnet'], 'claude:opus', CONFIGURED)).toBe(true);
      // …and open mode (no user system) gets the same existence bound.
      expect(isExecAllowedForUser(null, ['sonnet'], 'ai-coresynth-io/kimi-k3', CONFIGURED)).toBe(false);
      expect(isExecAllowedForUser(null, ['sonnet'], 'kimi-coding/k3', CONFIGURED)).toBe(true);
    });

    it('leaves non-brain execs alone — they are a different program\'s registry', () => {
      // `codex:gpt-5.5`, `opus` and `sonnet` are CLI-agent execs bounded by allowedExecs. No brain
      // provider list may touch them, and none of them may be read as a brain model reference.
      const globalExecs = ['sonnet', 'opus', 'codex:gpt-5.5'];
      for (const exec of ['sonnet', 'opus', 'codex:gpt-5.5']) {
        expect(isExecAllowedForUser({ is_admin: false, allowed_execs: [] }, globalExecs, exec, CONFIGURED)).toBe(true);
        expect(isModelVisibleForUser(null, globalExecs, exec, CONFIGURED)).toBe(true);
      }
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
