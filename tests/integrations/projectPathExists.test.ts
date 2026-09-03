import { afterEach, describe, expect, it, vi } from 'vitest';

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat }));

const { PROJECT_PATH_EXISTS_TIMEOUT_MS, projectPathExists } = await import('../../src/integrations/projectFiles.js');

afterEach(() => {
  vi.useRealTimers();
  stat.mockReset();
});

describe('projectPathExists timeout', () => {
  it('returns false after the bounded wait while the underlying stat remains unsettled', async () => {
    vi.useFakeTimers();
    stat.mockReturnValue(new Promise(() => undefined));

    const result = projectPathExists('/slow/mount');
    await vi.advanceTimersByTimeAsync(PROJECT_PATH_EXISTS_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
    expect(stat).toHaveBeenCalledWith('/slow/mount');
  });
});
