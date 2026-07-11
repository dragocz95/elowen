import { describe, expect, it } from 'vitest';
import { AsyncPublicationFence } from '../../../src/cli/chat/asyncPublicationFence.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe('AsyncPublicationFence', () => {
  it('prevents stale metadata and rate-limit promises from mutating after a session switch', async () => {
    const fence = new AsyncPublicationFence<'metadata' | 'rate-limits'>();
    const metadata = deferred<string>();
    const limits = deferred<string>();
    const state = { metadata: 'A', limits: 'A' };
    const metadataToken = fence.begin('metadata');
    const limitsToken = fence.begin('rate-limits');
    const oldMetadata = metadata.promise.then((value) => fence.commit(metadataToken, () => { state.metadata = value; }));
    const oldLimits = limits.promise.then((value) => fence.commit(limitsToken, () => { state.limits = value; }));

    fence.invalidate();
    metadata.resolve('stale metadata');
    limits.resolve('stale limits');
    expect(await oldMetadata).toBe(false);
    expect(await oldLimits).toBe(false);
    expect(state).toEqual({ metadata: 'A', limits: 'A' });

    const fresh = fence.begin('metadata');
    expect(fence.commit(fresh, () => { state.metadata = 'B'; })).toBe(true);
    expect(state.metadata).toBe('B');
  });

  it('prevents every late publication after teardown', () => {
    const fence = new AsyncPublicationFence<'metadata' | 'rate-limits'>();
    const metadata = fence.begin('metadata');
    const limits = fence.begin('rate-limits');
    let mutations = 0;
    fence.stop();

    expect(fence.commit(metadata, () => { mutations += 1; })).toBe(false);
    expect(fence.commit(limits, () => { mutations += 1; })).toBe(false);
    expect(mutations).toBe(0);
  });
});
