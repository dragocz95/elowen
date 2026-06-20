import { describe, it, expect } from 'vitest';
import { taskTypeMeta, statusLabel, taskTypeLabel, TASK_TYPES, PRIORITIES } from '../../../modules/tasks/taskMeta';
import { en } from '../../../lib/i18n/dictionaries/en';
import { cs } from '../../../lib/i18n/dictionaries/cs';

describe('taskTypeMeta', () => {
  it('maps known types to a label and tone', () => {
    expect(taskTypeMeta('bug').label).toBe('Bug');
    expect(taskTypeMeta('bug').tone).toBe('danger');
    expect(taskTypeMeta('epic').label).toBe('Epic');
  });
  it('falls back for unknown types without throwing', () => {
    const meta = taskTypeMeta('whatever');
    expect(meta.label).toBe('whatever');
    expect(meta.icon).toBeTruthy();
  });
  it('defaults to task when type is undefined', () => {
    expect(taskTypeMeta(undefined).label).toBe('Task');
  });
  it('exposes the type and priority option lists', () => {
    expect(TASK_TYPES).toContain('feature');
    expect(PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3']);
  });
});

describe('statusLabel', () => {
  it('maps known statuses through the dictionary (EN + CS)', () => {
    expect(statusLabel(en, 'in_progress')).toBe(en.tasks.statusInProgress);
    expect(statusLabel(en, 'cancelled')).toBe(en.tasks.statusCancelled);
    expect(statusLabel(cs, 'blocked')).toBe(cs.tasks.statusBlocked);
  });
  it('falls back to the raw status for unknown values', () => {
    expect(statusLabel(en, 'mystery')).toBe('mystery');
  });
});

describe('taskTypeLabel', () => {
  it('maps known types through the dictionary (EN + CS)', () => {
    expect(taskTypeLabel(en, 'bug')).toBe(en.tasks.typeBug);
    expect(taskTypeLabel(cs, 'feature')).toBe(cs.tasks.typeFeature);
  });
  it('falls back to the English meta label for unknown types', () => {
    expect(taskTypeLabel(en, 'whatever')).toBe('whatever');
  });
});
