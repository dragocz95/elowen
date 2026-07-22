import { describe, expect, it } from 'vitest';
import { compactionReserveTokens, resolveAutoCompactPct } from '../../src/brain/session/factory.js';

describe('per-model auto-compact threshold', () => {
  it('uses the per-model override when set, else the global default', () => {
    const byModel = { 'relay/gpt-x': 65, 'ant/claude-x': 90 };
    // Override present for this provider/model → wins over the global.
    expect(resolveAutoCompactPct(byModel, 'relay', 'gpt-x', 80)).toBe(65);
    expect(resolveAutoCompactPct(byModel, 'ant', 'claude-x', 80)).toBe(90);
    // No override for this model → the global default applies.
    expect(resolveAutoCompactPct(byModel, 'relay', 'other', 80)).toBe(80);
    // No map at all → the global default.
    expect(resolveAutoCompactPct(undefined, 'relay', 'gpt-x', 75)).toBe(75);
  });

  it('keys per-model overrides by providerId/model, matching the context-window convention', () => {
    // The key is the config providerId (not the elowen- registry name) joined with the model id.
    expect(resolveAutoCompactPct({ 'relay/gpt-x': 50 }, 'relay', 'gpt-x', 80)).toBe(50);
    // A registry-style provider name must NOT match the config-keyed map.
    expect(resolveAutoCompactPct({ 'relay/gpt-x': 50 }, 'elowen-relay', 'gpt-x', 80)).toBe(80);
  });
});

describe('BrainSessionFactory compaction budget', () => {
  it('keeps a positive emergency summary budget when proactive compaction is disabled', () => {
    const reserve = compactionReserveTokens(200_000, false, 80);
    expect(reserve).toBe(4_096);
    // PI 0.80.6 derives summary maxTokens as floor(0.8 * reserveTokens).
    expect(Math.floor(0.8 * reserve)).toBeGreaterThan(0);
    expect(compactionReserveTokens(8_000, false, 80)).toBe(400);
  });

  it('preserves the configured proactive threshold', () => {
    expect(compactionReserveTokens(200_000, true, 80)).toBe(40_000);
    expect(compactionReserveTokens(200_000, true, 95)).toBe(10_000);
  });
});
