import { describe, expect, it, vi } from 'vitest';
import { runProviderRequestRetentionSweep } from '../../src/daemon/maintenance.js';

describe('provider request retention sweep', () => {
  it('translates the live day and MiB limits into the store cutoff and byte budget', () => {
    const pruneDiagnostics = vi.fn().mockReturnValue({ sessions: 2, storedBytes: 1234 });
    const now = 2_000_000_000_000;

    const result = runProviderRequestRetentionSweep({
      providerRequests: { pruneDiagnostics },
      limits: () => ({ providerRequestRetentionDays: 14, providerRequestRetentionMiB: 1024 }),
      now: () => now,
    });

    expect(pruneDiagnostics).toHaveBeenCalledWith(now - 14 * 86_400_000, 1024 * 1_048_576);
    expect(result).toEqual({ sessions: 2, storedBytes: 1234 });
  });
});
