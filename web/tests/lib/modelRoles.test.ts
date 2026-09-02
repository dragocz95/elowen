import { describe, it, expect } from 'vitest';
import { isOfferedModel, resolveDigestRoute, roleKey, splitRoleKey } from '../../lib/modelRoles';
import type { BrainModelOption } from '../../lib/types';

const CATALOG: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
  { provider: 'relay', providerLabel: 'Relay', model: 'vendor/model-with/slashes', exec: 'elowen:relay/vendor/model-with/slashes', source: 'api-key', contextWindow: 8192, contextWindowSet: false },
];

describe('roleKey', () => {
  it('round-trips a model id that itself contains slashes', () => {
    const key = roleKey('relay', 'vendor/model-with/slashes');
    expect(splitRoleKey(key)).toEqual({ providerId: 'relay', model: 'vendor/model-with/slashes' });
  });

  it('treats a half-set pair as no pick at all, in both directions', () => {
    expect(roleKey('relay', '')).toBe('');
    expect(roleKey('', 'claude-opus')).toBe('');
    expect(splitRoleKey('')).toEqual({ providerId: '', model: '' });
  });
});

/** The runtime uses the digest route ONLY when both halves are set (`dashDigestInference` in
 *  `src/daemon/brainCore.ts`); anything else falls through to the utility route. Reading
 *  `digest.model || categorization.model` reported the orphaned half of a half-set pair as the digest
 *  model while the daemon quietly ran the utility one — Recap and Models each said something untrue. */
describe('resolveDigestRoute mirrors the daemon rule', () => {
  const utility = { providerId: 'anthropic', model: 'claude-haiku' };

  it('uses a complete digest pair as its own route', () => {
    expect(resolveDigestRoute({ providerId: 'relay', model: 'glm' }, utility))
      .toEqual({ route: { providerId: 'relay', model: 'glm' }, inherited: false });
  });

  it('inherits the utility route for a digest pair missing its provider', () => {
    expect(resolveDigestRoute({ providerId: '', model: 'x' }, utility))
      .toEqual({ route: utility, inherited: true });
  });

  it('inherits the utility route for a digest pair missing its model', () => {
    expect(resolveDigestRoute({ providerId: 'p', model: '' }, utility))
      .toEqual({ route: utility, inherited: true });
  });

  it('inherits when nothing is set, and reports no route when the utility half is broken too', () => {
    expect(resolveDigestRoute(undefined, utility)).toEqual({ route: utility, inherited: true });
    expect(resolveDigestRoute({ providerId: '', model: '' }, { providerId: 'p', model: '' }))
      .toEqual({ route: null, inherited: true });
    expect(resolveDigestRoute(undefined, undefined)).toEqual({ route: null, inherited: true });
  });
});

describe('isOfferedModel', () => {
  it('treats the empty key as the inherit sentinel rather than a missing model', () => {
    expect(isOfferedModel('', CATALOG)).toBe(true);
    expect(isOfferedModel('', [])).toBe(true);
  });

  it('recognises an offered pair, slashes and all, and rejects one the catalog dropped', () => {
    expect(isOfferedModel(roleKey('relay', 'vendor/model-with/slashes'), CATALOG)).toBe(true);
    expect(isOfferedModel(roleKey('anthropic', 'claude-opus'), CATALOG)).toBe(true);
    // The provider is gone, or the allow-list no longer permits it — either way the runtime skips it.
    expect(isOfferedModel(roleKey('deleted', 'claude-opus'), CATALOG)).toBe(false);
    expect(isOfferedModel(roleKey('anthropic', 'retired-model'), CATALOG)).toBe(false);
  });
});
