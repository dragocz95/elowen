import { describe, it, expect } from 'vitest';
import { statusTone } from '../../../modules/dashboard/statusTone';

describe('statusTone', () => {
  it('maps each status to its tone', () => {
    expect(statusTone('open')).toBe('success');
    expect(statusTone('in_progress')).toBe('warning');
    expect(statusTone('blocked')).toBe('danger');
    expect(statusTone('closed')).toBe('danger');
    expect(statusTone('cancelled')).toBe('muted');
  });
});
