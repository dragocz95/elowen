import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { DEFAULT_MEMORY_RETENTION } from '../../src/brain/memoryVitality.js';

/** The runtime knobs are the sibling group of the brain limits: same contract (whole numbers, per-field
 *  clamp, a partial patch never resetting a sibling), different domain. Every default here must equal the
 *  hardcoded value it replaced, or enabling the setting would itself change behaviour. */
describe('ConfigStore runtime limits', () => {
  it('defaults to the values that were hardcoded before the setting existed', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime).toEqual({
      limits: {
        localShellTimeoutMs: 30_000,      // LOCAL_SHELL_TIMEOUT_MS
        memorySemanticFloorPerMille: 200, // MIN_SEMANTIC 0.2
        memoryDuplicatePerMille: 930,     // DEFAULT_SIMILAR_THRESHOLD 0.93
        memoryParaphrasePerMille: 700,    // DEDUPE_COSINE 0.70
        memoryImportanceWeightPerMille: 100, // W_IMPORTANCE 0.1
        memoryVitalityWeightPerMille: 100,   // W_VITALITY 0.1
        memoryCuratorMaxOps: 2,           // MAX_OPS_PER_TURN
        toolDeferThreshold: 10,           // DEFAULT_DEFER_THRESHOLD
        eventRetentionDays: 30,           // purgeOlderThan(days = 30)
        originIpRetentionDays: 30,        // IP redaction horizon
        streamSilenceLimitMs: 75_000,     // SILENCE_LIMIT_MS
        streamReviveSilenceLimitMs: 45_000, // REVIVE_SILENCE_LIMIT_MS
        toastDurationMs: 4_500,           // TOAST_MS
      },
      toolDeferralEnabled: true,
      toolDeferralOverrides: { sources: {}, tools: {} },
      hostedToolSearch: {},
      // ON: in-process sub-agents share the daemon's one JS thread, so a fan-out starves the interactive
      // path. `false` remains the pre-runner code path, i.e. the rollback an operator can reach for.
      subagentRunnerEnabled: true,
      // AUTO: the pool measures the machine it is on, because any hard-coded count would be wrong on
      // either a 2-core VPS or a 16-core server. An operator only sets a number when those inputs lie.
      subagentRunnerPoolMax: null,
      // ON: the session factory narrows provider-side compaction to openai-codex, and a provider that
      // cannot produce a blob falls back to the very text summary it replaces — so the switch is the kill
      // switch for an undocumented beta, not an opt-in an operator has to find.
      remoteCompactionEnabled: true,
      providerRequestCaptureEnabled: true,
      memoryRetention: DEFAULT_MEMORY_RETENTION,
    });
  });

  it('accepts every knob at both edges of its range', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    const low = {
      localShellTimeoutMs: 10_000, memorySemanticFloorPerMille: 100,
      memoryDuplicatePerMille: 500, memoryParaphrasePerMille: 500,
      memoryImportanceWeightPerMille: 0, memoryVitalityWeightPerMille: 0, memoryCuratorMaxOps: 0,
      toolDeferThreshold: 1, eventRetentionDays: 1, originIpRetentionDays: 1,
      streamSilenceLimitMs: 35_000, streamReviveSilenceLimitMs: 35_000, toastDurationMs: 2_000,
    };
    cs.update({ runtime: { limits: low } });
    expect(cs.get().runtime.limits).toEqual(low);
    const high = {
      localShellTimeoutMs: 300_000, memorySemanticFloorPerMille: 800,
      memoryDuplicatePerMille: 980, memoryParaphrasePerMille: 980,
      memoryImportanceWeightPerMille: 300, memoryVitalityWeightPerMille: 300, memoryCuratorMaxOps: 6,
      toolDeferThreshold: 100, eventRetentionDays: 365, originIpRetentionDays: 365,
      streamSilenceLimitMs: 300_000, streamReviveSilenceLimitMs: 300_000, toastDurationMs: 15_000,
    };
    cs.update({ runtime: { limits: high } });
    expect(cs.get().runtime.limits).toEqual(high);
  });

  it('clamps a value past either end back into range', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { localShellTimeoutMs: 1, memorySemanticFloorPerMille: 0, memoryDuplicatePerMille: 0, memoryParaphrasePerMille: 0, memoryImportanceWeightPerMille: -50, memoryVitalityWeightPerMille: -50, memoryCuratorMaxOps: -1, toolDeferThreshold: 0, eventRetentionDays: 0, originIpRetentionDays: 0, streamSilenceLimitMs: 1_000, streamReviveSilenceLimitMs: 1_000, toastDurationMs: 100 } } });
    expect(cs.get().runtime.limits).toEqual({
      localShellTimeoutMs: 10_000, memorySemanticFloorPerMille: 100,
      memoryDuplicatePerMille: 500, memoryParaphrasePerMille: 500,
      memoryImportanceWeightPerMille: 0, memoryVitalityWeightPerMille: 0, memoryCuratorMaxOps: 0,
      toolDeferThreshold: 1, eventRetentionDays: 1, originIpRetentionDays: 1,
      streamSilenceLimitMs: 35_000, streamReviveSilenceLimitMs: 35_000, toastDurationMs: 2_000,
    });
    cs.update({ runtime: { limits: { localShellTimeoutMs: 9_000_000, memorySemanticFloorPerMille: 1_000, memoryDuplicatePerMille: 1_000, memoryParaphrasePerMille: 1_000, memoryImportanceWeightPerMille: 900, memoryVitalityWeightPerMille: 900, memoryCuratorMaxOps: 99, toolDeferThreshold: 5_000, eventRetentionDays: 10_000, originIpRetentionDays: 10_000, streamSilenceLimitMs: 9_000_000, streamReviveSilenceLimitMs: 9_000_000, toastDurationMs: 9_000_000 } } });
    expect(cs.get().runtime.limits).toEqual({
      localShellTimeoutMs: 300_000, memorySemanticFloorPerMille: 800,
      memoryDuplicatePerMille: 980, memoryParaphrasePerMille: 980,
      memoryImportanceWeightPerMille: 300, memoryVitalityWeightPerMille: 300, memoryCuratorMaxOps: 6,
      toolDeferThreshold: 100, eventRetentionDays: 365, originIpRetentionDays: 365,
      streamSilenceLimitMs: 300_000, streamReviveSilenceLimitMs: 300_000, toastDurationMs: 15_000,
    });
  });

  it('merges a partial patch per-field without resetting siblings, and rounds a fractional value', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { toolDeferThreshold: 25 } } });
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(25);
    expect(cs.get().runtime.limits.eventRetentionDays).toBe(30); // sibling untouched
    cs.update({ runtime: { limits: { eventRetentionDays: 7.6 } } });
    expect(cs.get().runtime.limits.eventRetentionDays).toBe(8);
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(25); // still the earlier patch
  });

  it('ignores a non-finite value, keeping the current one', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { localShellTimeoutMs: 120_000 } } });
    cs.update({ runtime: { limits: { localShellTimeoutMs: Number.NaN } } });
    expect(cs.get().runtime.limits.localShellTimeoutMs).toBe(120_000);
  });

  // The floor is carried in per mille precisely so the whole-number clamp cannot destroy it: were it
  // stored as a cosine float, 0.3 would round to 0 and no memory would ever be filtered out again.
  it('keeps the semantic floor intact through the whole-number clamp', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { memorySemanticFloorPerMille: 450 } } });
    expect(cs.get().runtime.limits.memorySemanticFloorPerMille).toBe(450);
  });

  it('round-trips the deferral kill switch and leaves it alone on a limits-only patch', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { toolDeferralEnabled: false } });
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(10); // untouched by the switch patch
    cs.update({ runtime: { limits: { toolDeferThreshold: 12 } } });
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
    cs.update({ runtime: { toolDeferralEnabled: true } });
    expect(cs.get().runtime.toolDeferralEnabled).toBe(true);
  });

  it('persists probe-owned hosted search capabilities and ignores generic config spoofing', () => {
    const db = openDb(':memory:');
    const cs = new ConfigStore(db);
    cs.update({ runtime: { hostedToolSearch: { forged: { model: {
      status: 'supported', fingerprint: 'a'.repeat(64), checkedAt: 1, protocol: 'hosted-tool-search-v1',
    } } } } } as never);
    expect(cs.get().runtime.hostedToolSearch).toEqual({});

    cs.setHostedToolSearchCapability('azure', 'deployment/name', {
      status: 'supported', fingerprint: 'b'.repeat(64), checkedAt: 123, protocol: 'hosted-tool-search-v1',
    });
    expect(new ConfigStore(db).get().runtime.hostedToolSearch).toEqual({
      azure: { 'deployment/name': {
        status: 'supported', fingerprint: 'b'.repeat(64), checkedAt: 123, protocol: 'hosted-tool-search-v1',
      } },
    });
    cs.update({ runtime: { toolDeferralEnabled: false } });
    expect(cs.get().runtime.hostedToolSearch.azure?.['deployment/name']?.status).toBe('supported');
  });

  it('round-trips the sub-agent runner switch and leaves it alone on a limits-only patch', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime.subagentRunnerEnabled).toBe(true); // ON by default; off is the rollback position
    cs.update({ runtime: { subagentRunnerEnabled: false } });
    expect(cs.get().runtime.subagentRunnerEnabled).toBe(false);
    // An operator who switched delegated execution off did so to get out of trouble. Tuning any other
    // knob afterwards must not hand them the runner back, which is the direction that now matters:
    // the default is on, so a lost `false` silently re-enables it.
    cs.update({ runtime: { limits: { toolDeferThreshold: 12 } } });
    expect(cs.get().runtime.subagentRunnerEnabled).toBe(false);
    cs.update({ runtime: { toolDeferralEnabled: false } });
    expect(cs.get().runtime.subagentRunnerEnabled).toBe(false);
    cs.update({ runtime: { subagentRunnerEnabled: true } });
    expect(cs.get().runtime.subagentRunnerEnabled).toBe(true);
  });

  it('round-trips the remote-compaction switch and leaves it alone on a limits-only patch', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime.remoteCompactionEnabled).toBe(true); // ON by default; the switch is the kill switch
    cs.update({ runtime: { remoteCompactionEnabled: false } });
    expect(cs.get().runtime.remoteCompactionEnabled).toBe(false);
    // An operator who switched it off must not be silently switched back on by tuning an unrelated knob —
    // the default is on, so a lost `false` is the direction that would quietly undo the choice.
    cs.update({ runtime: { limits: { toolDeferThreshold: 12 } } });
    expect(cs.get().runtime.remoteCompactionEnabled).toBe(false);
    cs.update({ runtime: { subagentRunnerEnabled: false } });
    expect(cs.get().runtime.remoteCompactionEnabled).toBe(false);
    cs.update({ runtime: { remoteCompactionEnabled: true } });
    expect(cs.get().runtime.remoteCompactionEnabled).toBe(true);
  });

  it('round-trips the provider-request capture kill switch without deleting its state on sibling patches', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime.providerRequestCaptureEnabled).toBe(true);
    cs.update({ runtime: { providerRequestCaptureEnabled: false } });
    expect(cs.get().runtime.providerRequestCaptureEnabled).toBe(false);
    cs.update({ runtime: { limits: { toolDeferThreshold: 12 }, remoteCompactionEnabled: false } });
    expect(cs.get().runtime.providerRequestCaptureEnabled).toBe(false);
    cs.update({ runtime: { providerRequestCaptureEnabled: true } });
    expect(cs.get().runtime.providerRequestCaptureEnabled).toBe(true);
  });

  it('round-trips the pool size knob, including the two values that are not "a number"', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime.subagentRunnerPoolMax).toBeNull(); // auto — sized from the machine
    cs.update({ runtime: { subagentRunnerPoolMax: 3 } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBe(3);
    // 0 is a REAL setting (pool off, everything in-process), not "unset" — it must survive the round trip.
    cs.update({ runtime: { subagentRunnerPoolMax: 0 } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBe(0);
    // …and null is how an operator hands sizing back to the machine.
    cs.update({ runtime: { subagentRunnerPoolMax: null } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBeNull();
    // A sibling patch must not resize the pool behind the operator's back.
    cs.update({ runtime: { subagentRunnerPoolMax: 2 } });
    cs.update({ runtime: { toolDeferralEnabled: false } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBe(2);
  });

  // Not an answer to "how many runners" — taking it would silently resize the pool from corruption.
  it('keeps the current pool size when the patch value is not a count', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { subagentRunnerPoolMax: 4 } });
    cs.update({ runtime: { subagentRunnerPoolMax: -2 } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBe(4);
    cs.update({ runtime: { subagentRunnerPoolMax: Number.NaN } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBe(4);
    cs.update({ runtime: { subagentRunnerPoolMax: 2.7 } });
    expect(cs.get().runtime.subagentRunnerPoolMax).toBe(2); // a count is a whole number
  });

  it('leaves the whole runtime block alone when the patch touches another section', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { eventRetentionDays: 90 }, toolDeferralEnabled: false } });
    cs.update({ brain: { maxSteps: 30 } });
    expect(cs.get().runtime.limits.eventRetentionDays).toBe(90);
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
  });

  it('clamps maxSteps to the 1..1000 range', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { maxSteps: 5000 } });
    expect(cs.get().brain.maxSteps).toBe(1000); // ceiling raised from 200 to 1000
    cs.update({ brain: { maxSteps: 500 } });
    expect(cs.get().brain.maxSteps).toBe(500); // an in-range value passes through
    cs.update({ brain: { maxSteps: 0 } });
    expect(cs.get().brain.maxSteps).toBe(1); // floor
  });

  it('defaults tool deferral overrides to independent empty maps', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime.toolDeferralOverrides).toEqual({ sources: {}, tools: {} });
  });

  it('round-trips source and per-tool deferral overrides', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    const toolDeferralOverrides = {
      sources: { 'plugin:discord': 'deferred' as const, builtin: 'immediate' as const },
      tools: { 'plugin:discord': { DiscordApi: 'immediate' as const }, builtin: { GenerateImage: 'deferred' as const } },
    };
    cs.update({ runtime: { toolDeferralOverrides } });
    expect(cs.get().runtime.toolDeferralOverrides).toEqual(toolDeferralOverrides);
  });

  it('replaces override maps wholesale so deleting a key restores inheritance', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { toolDeferralOverrides: {
      sources: { 'plugin:discord': 'deferred', 'plugin:cronjob': 'immediate' },
      tools: { 'plugin:discord': { DiscordApi: 'immediate', DiscordCreateChannel: 'deferred' } },
    } } });
    cs.update({ runtime: { toolDeferralOverrides: {
      sources: { 'plugin:cronjob': 'immediate' },
      tools: { 'plugin:discord': { DiscordCreateChannel: 'deferred' } },
    } } });
    expect(cs.get().runtime.toolDeferralOverrides).toEqual({
      sources: { 'plugin:cronjob': 'immediate' },
      tools: { 'plugin:discord': { DiscordCreateChannel: 'deferred' } },
    });
  });

  it('drops malformed source ids, modes, and tool names from stored overrides', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      runtime: {
        toolDeferralOverrides: {
          sources: { builtin: 'deferred', 'plugin:discord': 'immediate', discord: 'deferred', 'plugin:': 'deferred', 'plugin:skills': 'later' },
          tools: {
            builtin: { GenerateImage: 'deferred', '': 'immediate', EditImage: 'later' },
            'plugin:discord': { DiscordApi: 'immediate', '': 'deferred' },
            discord: { DiscordDeleteChannel: 'deferred' },
          },
        },
      },
    }));
    expect(new ConfigStore(db).get().runtime.toolDeferralOverrides).toEqual({
      sources: { builtin: 'deferred', 'plugin:discord': 'immediate' },
      tools: { builtin: { GenerateImage: 'deferred' }, 'plugin:discord': { DiscordApi: 'immediate' } },
    });
  });

  it('leaves overrides untouched on a limits-only patch and limits untouched on an override patch', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    const toolDeferralOverrides = { sources: { 'plugin:discord': 'deferred' as const }, tools: {} };
    cs.update({ runtime: { toolDeferralOverrides } });
    cs.update({ runtime: { limits: { toolDeferThreshold: 25 } } });
    expect(cs.get().runtime.toolDeferralOverrides).toEqual(toolDeferralOverrides);
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(25);
    cs.update({ runtime: { toolDeferralOverrides: { sources: {}, tools: { builtin: { GenerateImage: 'deferred' } } } } });
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(25);
    expect(cs.get().runtime.toolDeferralOverrides).toEqual({ sources: {}, tools: { builtin: { GenerateImage: 'deferred' } } });
  });
});
