import { describe, expect, it } from 'vitest';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe('ChatApplicationLifetime', () => {
  it('owns one abort signal and suppresses every task callback after stop', async () => {
    const fence = new ChatApplicationLifetime<'metadata' | 'rate-limits'>();
    const pending = deferred<string>();
    const publications: string[] = [];
    let taskSignal: AbortSignal | null = null;

    fence.runApplication(
      (signal) => {
        taskSignal = signal;
        return pending.promise;
      },
      (value) => publications.push(`ok:${value}`),
      (error) => publications.push(`error:${error.message}`),
    );

    expect(taskSignal).toBe(fence.signal);
    expect(taskSignal?.aborted).toBe(false);
    fence.stop();
    expect(taskSignal?.aborted).toBe(true);

    pending.resolve('late');
    await Promise.resolve();
    await Promise.resolve();
    expect(publications).toEqual([]);
  });

  it('prevents stale metadata and rate-limit promises from mutating after a session switch', async () => {
    const fence = new ChatApplicationLifetime<'metadata' | 'rate-limits'>();
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
    const fence = new ChatApplicationLifetime<'metadata' | 'rate-limits'>();
    const metadata = fence.begin('metadata');
    const limits = fence.begin('rate-limits');
    let mutations = 0;
    fence.stop();

    expect(fence.commit(metadata, () => { mutations += 1; })).toBe(false);
    expect(fence.commit(limits, () => { mutations += 1; })).toBe(false);
    expect(mutations).toBe(0);
  });

  it('suppresses session-scoped task publications after the session epoch changes', async () => {
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const pending = deferred<string>();
    const publications: string[] = [];

    lifetime.runSession(
      () => pending.promise,
      (value) => publications.push(`ok:${value}`),
      (error) => publications.push(`error:${error.message}`),
    );
    lifetime.invalidate();
    pending.resolve('stale-session-A');
    await Promise.resolve();
    await Promise.resolve();

    expect(publications).toEqual([]);
  });

  it('keeps application-scoped task publications alive across a session switch', async () => {
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const pending = deferred<string>();
    const publications: string[] = [];

    lifetime.runApplication(
      () => pending.promise,
      (value) => publications.push(value),
    );
    lifetime.invalidate();
    pending.resolve('global-provider-refresh');
    await Promise.resolve();
    await Promise.resolve();

    expect(publications).toEqual(['global-provider-refresh']);
  });
});
