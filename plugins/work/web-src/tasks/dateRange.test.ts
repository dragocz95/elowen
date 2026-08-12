import { describe, it, expect } from 'vitest';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { taskDayMs, isUnscheduled } = await import('./dateRange');

describe('dateRange (task-specific helpers)', () => {
  it('isUnscheduled: true when neither scheduled_at nor closed_at is set', () => {
    const base = { id: '1', title: 'T', status: 'open' as const, created_at: '2026-06-01T10:00:00Z' };
    expect(isUnscheduled({ ...base })).toBe(true);
    // null values are also unscheduled
    expect(isUnscheduled({ ...base, scheduled_at: null, closed_at: null })).toBe(true);
    // in_progress with no schedule — must stay visible
    expect(isUnscheduled({ ...base, status: 'in_progress' as const })).toBe(true);
  });

  it('isUnscheduled: false when scheduled_at or closed_at is present', () => {
    const base = { id: '1', title: 'T', status: 'open' as const, created_at: '2026-06-01T10:00:00Z' };
    expect(isUnscheduled({ ...base, scheduled_at: '2026-06-20T09:00:00Z' })).toBe(false);
    expect(isUnscheduled({ ...base, closed_at: '2026-06-10T10:00:00Z' })).toBe(false);
    expect(isUnscheduled({ ...base, scheduled_at: '2026-06-20T09:00:00Z', closed_at: '2026-06-10T10:00:00Z' })).toBe(false);
  });

  it('taskDayMs returns scheduled_at over closed_at over created_at, 0 for dateless', () => {
    const base = { id: '1', title: 'T', status: 'open' as const, created_at: '2026-06-01T10:00:00Z', closed_at: null as null, scheduled_at: null as null };
    expect(taskDayMs({ ...base })).toBe(new Date('2026-06-01T10:00:00Z').getTime());
    expect(taskDayMs({ ...base, closed_at: '2026-06-10T10:00:00Z' })).toBe(new Date('2026-06-10T10:00:00Z').getTime());
    expect(taskDayMs({ ...base, scheduled_at: '2026-06-20T09:00:00Z', closed_at: '2026-06-10T10:00:00Z' })).toBe(new Date('2026-06-20T09:00:00Z').getTime());
    // No date fields at all → 0 (dateless tasks never hide from any filter)
    expect(taskDayMs({ id: '2', title: 'T', status: 'open' as const })).toBe(0);
  });
});
