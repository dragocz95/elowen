import { describe, it, expect } from 'vitest';
import { defaultUserSessionId, freshUserSessionId, channelSessionId, taskSessionId, isNonUserSession } from '../../src/brain/sessionId.js';

describe('brain session id conventions', () => {
  it('builds the four id shapes', () => {
    expect(defaultUserSessionId(7)).toBe('brain-7');
    expect(freshUserSessionId(7)).toMatch(/^brain-7-[a-z0-9]+$/);
    expect(channelSessionId('discord-123')).toBe('brain-ch-discord-123');
    expect(taskSessionId('t42')).toBe('brain-task-t42');
  });

  it('classifies channel/task sessions as non-user (excluded from list/resume/delete)', () => {
    expect(isNonUserSession(channelSessionId('x'))).toBe(true);
    expect(isNonUserSession(taskSessionId('x'))).toBe(true);
    expect(isNonUserSession(defaultUserSessionId(1))).toBe(false);
    expect(isNonUserSession('brain-1-abc123')).toBe(false);
  });
});
