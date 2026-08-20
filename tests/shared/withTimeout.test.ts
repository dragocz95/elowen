import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout } from '../../src/shared/withTimeout.js';

afterEach(() => { vi.useRealTimers(); });

describe('withTimeout', () => {
  it('resolves with the work when it settles first', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000, 'too slow')).resolves.toBe('done');
  });

  it('propagates the work\'s own rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('inner')), 1000, 'too slow')).rejects.toThrow('inner');
  });

  it('rejects with the caller\'s message once the window elapses', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => {}), 20_000, 'brain did not respond within 20s');
    const assertion = expect(pending).rejects.toThrow('brain did not respond within 20s');
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('clears the timer when the work wins, leaving nothing pending', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve('fast'), 30_000, 'stop exceeded 30000ms')).resolves.toBe('fast');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when the work rejects', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.reject(new Error('boom')), 30_000, 'too slow')).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fire after the work already won', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    await withTimeout(Promise.resolve('fast'), 1000, 'too slow').then(settled);
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
