import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForSseHeartbeat } from '../../src/api/routes/brainStream.js';

afterEach(() => { vi.useRealTimers(); });

describe('SSE heartbeat wait', () => {
  it('resolves immediately on disconnect and removes its timer listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForSseHeartbeat(30_000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
