import { describe, it, expect } from 'vitest';
import { eventTone } from '../../../modules/timeline/eventMeta';

describe('eventTone', () => {
  it('maps types to tones', () => {
    expect(eventTone('task')).toBe('accent');
    expect(eventTone('mission')).toBe('accent');
    expect(eventTone('signal')).toBe('muted');
    expect(eventTone('other')).toBe('default');
  });
});
