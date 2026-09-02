import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore, DEFAULT_OPENAI_COMPATIBILITY } from '../../src/store/configStore.js';

const entry = { id: 'relay', label: 'CoreSynth', type: 'openai', baseUrl: 'https://ai.example/v1', models: ['m1'], apiKey: 'sek' };

describe('ConfigStore brain providers', () => {
  it('defaults to no providers', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().brain.providers).toEqual([]);
  });

  it('round-trips a provider, stripping the key to apiKeySet in the public view', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry] } });
    expect(cs.get().brain.providers).toEqual([
      {
        id: 'relay', label: 'CoreSynth', type: 'openai', baseUrl: 'https://ai.example/v1', models: ['m1'],
        compatibility: DEFAULT_OPENAI_COMPATIBILITY, apiKeySet: true,
      },
    ]);
    expect(JSON.stringify(cs.get())).not.toContain('sek');
    expect(cs.brainProviders()[0]?.apiKey).toBe('sek');
  });

  it('keeps the stored key when a patched entry arrives keyless', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry] } });
    cs.update({ brain: { providers: [{ ...entry, apiKey: undefined, label: 'Renamed' }] } });
    expect(cs.brainProviders()[0]?.apiKey).toBe('sek');
    expect(cs.brainProviders()[0]?.label).toBe('Renamed');
  });

  it('drops malformed entries and duplicate ids', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry, { ...entry, label: 'dup' }, { ...entry, id: 'ambiguous/provider' }, { id: '', type: 'openai' }, { id: 'x', type: 'bogus' }, 'junk'] } });
    expect(cs.brainProviders().map((p) => p.id)).toEqual(['relay']);
  });

  it('removing an entry via a wholesale update deletes it (and its key)', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry] } });
    cs.update({ brain: { providers: [] } });
    expect(cs.brainProviders()).toEqual([]);
  });
});

describe('ConfigStore brain limits', () => {
  it('defaults to the built-in limits', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().brain.limits).toEqual({
      toolOutputMaxLines: 100, toolOutputMaxChars: 41000, toolResultInlineBytes: 60000,
      toolResultGroupBudgetBytes: 200000, compactionFailureLimit: 3, elicitationTimeoutMs: 21600000,
      memoryRecallCount: 10, memoryRecallChars: 20000,
      memoryLiveRecallPasses: 10, memoryLiveRecallCount: 2, memoryLiveRecallBytes: 20000,
      goalTurnBudget: 50, goalMaxTurns: 50, channelSessionCap: 32,
      delegateContextChars: 40000,
    });
  });

  // Every tuning knob's LOWER bound is its default −50%, derived from the default so the two cannot drift
  // apart. Three ceilings are raised past the +50% rule at the owner's request (tool output lines/chars
  // and memory recall chars), so those are pinned to their explicit overrides instead.
  it('accepts a tuning knob anywhere in its band and clamps beyond it', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { toolOutputMaxChars: 22_000, memoryRecallChars: 12_000, toolOutputMaxLines: 200 } } });
    expect(cs.get().brain.limits.toolOutputMaxChars).toBe(22000);
    expect(cs.get().brain.limits.memoryRecallChars).toBe(12000);
    expect(cs.get().brain.limits.toolOutputMaxLines).toBe(200); // upper edge, exactly in range
    cs.update({ brain: { limits: { toolOutputMaxChars: 500_000, memoryRecallChars: 100_000, toolOutputMaxLines: 1 } } });
    expect(cs.get().brain.limits.toolOutputMaxChars).toBe(80000); // explicit ceiling, ~20k tokens
    expect(cs.get().brain.limits.memoryRecallChars).toBe(40000);  // explicit ceiling, ~10k tokens
    expect(cs.get().brain.limits.toolOutputMaxLines).toBe(50);    // 100 − 50%
  });

  it('honours live-recall batch and byte ceilings', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({
      brain: { limits: { memoryRecallChars: 40_000, memoryLiveRecallBytes: 40_000, memoryLiveRecallCount: 10 } },
    });
    expect(cs.get().brain.limits.memoryRecallChars).toBe(40_000);
    expect(cs.get().brain.limits.memoryLiveRecallBytes).toBe(40_000);
    expect(cs.get().brain.limits.memoryLiveRecallCount).toBe(10);
    cs.update({
      brain: { limits: { memoryRecallChars: 999_999, memoryLiveRecallBytes: 999_999, memoryLiveRecallCount: 999 } },
    });
    expect(cs.get().brain.limits.memoryRecallChars).toBe(40_000);
    expect(cs.get().brain.limits.memoryLiveRecallBytes).toBe(40_000);
    expect(cs.get().brain.limits.memoryLiveRecallCount).toBe(10);
    expect(cs.get().brain.limits.memoryLiveRecallCount).not.toBe(0);
  });

  it('normalizes legacy whole-turn recall settings into a safe batch configuration', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      brain: { limits: { memoryLiveRecallPasses: 10, memoryLiveRecallCount: 10, memoryLiveRecallChars: 20_000 } },
    }));
    const cs = new ConfigStore(db);

    expect(cs.get().brain.limits.memoryLiveRecallPasses).toBe(10);
    expect(cs.get().brain.limits.memoryLiveRecallCount).toBe(2);
    expect(cs.get().brain.limits.memoryLiveRecallBytes).toBe(20_000);

    cs.update({ brain: { limits: { memoryLiveRecallCount: 4 } } });
    expect(cs.get().brain.limits.memoryLiveRecallCount).toBe(4);
    const stored = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
    expect(stored.data).toContain('memoryLiveRecallPasses');
    expect(stored.data).not.toContain('memoryLiveRecallChars');
  });

  it('keeps an explicitly disabled legacy recall setting disabled', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      brain: { limits: { memoryLiveRecallPasses: 0, memoryLiveRecallCount: 10, memoryLiveRecallChars: 20_000 } },
    }));
    expect(new ConfigStore(db).get().brain.limits.memoryLiveRecallCount).toBe(0);
  });

  // The aggregate tool-result budget bands at ±50%, and its floor is the load-bearing part: 100 000 stays
  // above the per-result ceiling (75 000), so no reachable setting can make the aggregate layer spill a
  // result the per-result layer would have kept inline.
  it('keeps the tool-result group budget above the per-result ceiling', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { toolResultGroupBudgetBytes: 120_000 } } });
    expect(cs.get().brain.limits.toolResultGroupBudgetBytes).toBe(120_000);
    cs.update({ brain: { limits: { toolResultGroupBudgetBytes: 1_000 } } });
    expect(cs.get().brain.limits.toolResultGroupBudgetBytes).toBe(100_000); // 200 000 − 50%
    expect(cs.get().brain.limits.toolResultGroupBudgetBytes).toBeGreaterThan(cs.get().brain.limits.toolResultInlineBytes);
    cs.update({ brain: { limits: { toolResultGroupBudgetBytes: 5_000_000 } } });
    expect(cs.get().brain.limits.toolResultGroupBudgetBytes).toBe(300_000); // 200 000 + 50%
  });

  // 0 must stay unreachable: it would trip the compaction breaker before a session ever attempted a
  // compaction, turning the knob into a silent "never compact automatically".
  it('never lets the compaction failure limit reach zero', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { compactionFailureLimit: 0 } } });
    expect(cs.get().brain.limits.compactionFailureLimit).toBe(1);
    cs.update({ brain: { limits: { compactionFailureLimit: -5 } } });
    expect(cs.get().brain.limits.compactionFailureLimit).toBe(1);
    cs.update({ brain: { limits: { compactionFailureLimit: 7 } } });
    expect(cs.get().brain.limits.compactionFailureLimit).toBe(7);
    cs.update({ brain: { limits: { compactionFailureLimit: 99 } } });
    expect(cs.get().brain.limits.compactionFailureLimit).toBe(10);
  });

  // These four are exempt from the ±50% rule because their range is load-bearing: the far ends are real
  // operating points, not slack. The 6 hour question timeout was an explicit owner request — a question
  // may wait out a whole working day — and the two goal knobs span the same range on purpose: a per-goal
  // budget that could not approach its own ceiling would make that ceiling unreachable.
  it('lets the exempt limits reach their far ends and clamps past them', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { elicitationTimeoutMs: 21_600_000, goalTurnBudget: 500, goalMaxTurns: 500, channelSessionCap: 256 } } });
    expect(cs.get().brain.limits.elicitationTimeoutMs).toBe(21_600_000);
    expect(cs.get().brain.limits.goalTurnBudget).toBe(500);
    expect(cs.get().brain.limits.goalMaxTurns).toBe(500);
    expect(cs.get().brain.limits.channelSessionCap).toBe(256);
    cs.update({ brain: { limits: { elicitationTimeoutMs: 30_000, goalTurnBudget: 4, goalMaxTurns: 8, channelSessionCap: 4 } } });
    expect(cs.get().brain.limits.elicitationTimeoutMs).toBe(30_000);
    expect(cs.get().brain.limits.goalTurnBudget).toBe(4);
    expect(cs.get().brain.limits.goalMaxTurns).toBe(8);
    expect(cs.get().brain.limits.channelSessionCap).toBe(4);
    cs.update({ brain: { limits: { elicitationTimeoutMs: 86_400_000, goalTurnBudget: 999, goalMaxTurns: 999, channelSessionCap: 1 } } });
    expect(cs.get().brain.limits.elicitationTimeoutMs).toBe(21_600_000);
    expect(cs.get().brain.limits.goalTurnBudget).toBe(500);
    expect(cs.get().brain.limits.goalMaxTurns).toBe(500);
    expect(cs.get().brain.limits.channelSessionCap).toBe(4);
  });

  // The sub-agent context budget's ceiling is not the ±50% rule: packing re-trims anything above the
  // delegated-scope prompt total, which is shared with the child's role prompt. Both were raised together
  // (80 000 here against a 120 000 total) so the ceiling stays reachable rather than trimmed back off.
  it('caps the sub-agent context budget at what a packed delegated scope can carry', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { delegateContextChars: 500_000 } } });
    expect(cs.get().brain.limits.delegateContextChars).toBe(80000);
    cs.update({ brain: { limits: { delegateContextChars: 10 } } });
    expect(cs.get().brain.limits.delegateContextChars).toBe(20000);
    cs.update({ brain: { limits: { delegateContextChars: 32_345 } } });
    expect(cs.get().brain.limits.delegateContextChars).toBe(32345);
  });

  it('merges a partial patch per-field without resetting siblings, and clamps out-of-range values', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { goalTurnBudget: 10 } } });
    expect(cs.get().brain.limits.goalTurnBudget).toBe(10);
    expect(cs.get().brain.limits.memoryRecallCount).toBe(10); // sibling untouched
    // Clamp both ends + round a fractional value to a whole number.
    cs.update({ brain: { limits: { goalTurnBudget: 999, memoryRecallCount: 0, channelSessionCap: 40.7 } } });
    expect(cs.get().brain.limits.goalTurnBudget).toBe(500);  // exempt: shares goalMaxTurns' ceiling
    expect(cs.get().brain.limits.memoryRecallCount).toBe(5); // min 5 (10 − 50%)
    expect(cs.get().brain.limits.channelSessionCap).toBe(41); // rounded, in range
  });

  it('ignores a non-finite value, keeping the current one', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { goalMaxTurns: 100 } } });
    cs.update({ brain: { limits: { goalMaxTurns: Number.NaN } } });
    expect(cs.get().brain.limits.goalMaxTurns).toBe(100);
  });
});

describe('brain provider wire-API (api) round-trip', () => {
  const oa = { id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-x'] };

  it('persists the pin, exposes it in the public view, and keeps it across a keyless echo', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [{ ...oa, api: 'openai-completions', apiKey: 'sk-1' }] } });
    expect(cs.get().brain.providers[0]).toMatchObject({ api: 'openai-completions', apiKeySet: true });
    // The UI/setup round-trip re-sends the keyless public entry — pin AND key must both survive.
    cs.update({ brain: { providers: [{ ...oa, api: 'openai-completions' }] } });
    expect(cs.brainProviders()[0]).toMatchObject({ api: 'openai-completions', apiKey: 'sk-1' });
  });

  it('an entry arriving WITHOUT api resets the pin to auto (documented contract)', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [{ ...oa, api: 'openai-responses', apiKey: 'sk-1' }] } });
    cs.update({ brain: { providers: [{ ...oa }] } });
    expect(cs.get().brain.providers[0]!.api).toBeUndefined();
  });

  it('drops api on non-openai types and rejects unknown values', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [
      { id: 'an', label: 'Ant', type: 'anthropic', baseUrl: '', models: [], api: 'openai-responses' },
      { ...oa, api: 'not-a-real-api' },
    ] } });
    expect(cs.get().brain.providers.find((p) => p.id === 'an')!.api).toBeUndefined();
    expect(cs.get().brain.providers.find((p) => p.id === 'oa')!.api).toBeUndefined();
  });

  it('persists an oauth-kimi entry', () => {
    // The runtime allowlist in sanitizeBrainProviders is a membership test, not an exhaustive one, so a
    // type the union gained and the array did not is dropped here without a word.
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [{ id: 'kimi-coding', label: 'Kimi account', type: 'oauth-kimi', baseUrl: '', models: [], apiKey: null }] } });
    expect(cs.get().brain.providers.map((p) => p.type)).toEqual(['oauth-kimi']);
  });

  describe('OpenAI compatibility', () => {
    it('defaults custom endpoints to the conservative request shape', () => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [entry] } });
      expect(cs.brainProviders()[0]?.compatibility).toEqual(DEFAULT_OPENAI_COMPATIBILITY);
    });

    it('round-trips explicit capabilities and sanitizes invalid fields independently', () => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [{ ...entry, compatibility: {
        supportsDeveloperRole: true,
        supportsLongCacheRetention: true,
        supportsUsageInStreaming: false,
        supportsStrictMode: true,
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: 'max_tokens',
        ignored: true,
      } }] } });
      expect(cs.brainProviders()[0]?.compatibility).toEqual({
        supportsDeveloperRole: true,
        supportsLongCacheRetention: true,
        supportsUsageInStreaming: false,
        supportsStrictMode: true,
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: 'max_tokens',
      });

      cs.update({ brain: { providers: [{ ...entry, compatibility: {
        supportsDeveloperRole: 'yes', maxTokensField: 'wrong',
      } }] } });
      expect(cs.brainProviders()[0]?.compatibility).toEqual(DEFAULT_OPENAI_COMPATIBILITY);
    });

    it('drops compatibility settings from non-OpenAI providers', () => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [{
        id: 'ant', label: 'Anthropic', type: 'anthropic', baseUrl: '', models: ['claude'],
        compatibility: { ...DEFAULT_OPENAI_COMPATIBILITY, supportsLongCacheRetention: true },
      }] } });
      expect(cs.brainProviders()[0]).not.toHaveProperty('compatibility');
    });
  });

  describe('temperature', () => {
    const withTemp = (temperature: unknown) => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [{ ...entry, temperature }] } });
      return cs.brainProviders()[0]?.temperature;
    };

    it('round-trips a value in range, including the edges and 0', () => {
      expect(withTemp(0.7)).toBe(0.7);
      expect(withTemp(0)).toBe(0); // a real setting, not "unset"
      expect(withTemp(2)).toBe(2);
    });

    it('drops anything out of range or not a finite number', () => {
      // Dropped rather than clamped: sending a temperature we invented is worse than sending none, and
      // "none" is a valid request against every endpoint.
      for (const bad of [-0.1, 2.1, Number.NaN, Number.POSITIVE_INFINITY, '0.7', null, {}]) {
        expect(withTemp(bad)).toBeUndefined();
      }
    });

    it('is absent by default so no temperature reaches the wire', () => {
      // Load-bearing: Kimi K3 rejects any temperature but its own default, as does Claude Opus 4.7+.
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [entry] } });
      expect(cs.brainProviders()[0]).not.toHaveProperty('temperature');
      expect(cs.get().brain.providers[0]).not.toHaveProperty('temperature');
    });
  });

  describe('hostedToolSearchEnabled', () => {
    const withFlag = (hostedToolSearchEnabled: unknown) => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [{ ...entry, hostedToolSearchEnabled }] } } as never);
      return cs.brainProviders()[0];
    };

    it('persists the operator’s off switch', () => {
      expect(withFlag(false)?.hostedToolSearchEnabled).toBe(false);
    });

    it('stores no value that could ENABLE a route', () => {
      // The provider row is client-writable through the generic config PATCH, so the only thing it may
      // ever say is "off". `true` is not a second spelling of the default — it is dropped, which is what
      // keeps a forged patch from promoting an unprobed Azure deployment. Anything malformed lands on the
      // same default rather than on a partially-honoured value.
      for (const bad of [true, 'false', 0, 1, null, {}, []]) {
        expect(withFlag(bad)).not.toHaveProperty('hostedToolSearchEnabled');
      }
    });

    it('is absent by default, and omitting it is how the switch goes back on', () => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [{ ...entry, hostedToolSearchEnabled: false }] } } as never);
      expect(cs.brainProviders()[0]?.hostedToolSearchEnabled).toBe(false);

      cs.update({ brain: { providers: [entry] } });
      expect(cs.brainProviders()[0]).not.toHaveProperty('hostedToolSearchEnabled');
      expect(cs.get().brain.providers[0]).not.toHaveProperty('hostedToolSearchEnabled');
    });
  });
});
