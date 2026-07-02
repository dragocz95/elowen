import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserSettingStore } from '../../src/store/userSettingStore.js';

describe('UserSettingStore', () => {
  it('defaults CLI settings when nothing is stored', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.cliSettings(1)).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '' });
  });

  it('round-trips model + autoCompact + threshold via the typed helper', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, advisorStyle: 'professional', discordUserId: '' });
    expect(s.cliSettings(1)).toEqual({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, advisorStyle: 'professional', discordUserId: '' });
  });

  it('clamps the auto-compact threshold into the safe band', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { autoCompactAt: 5 });
    expect(s.cliSettings(1).autoCompactAt).toBe(30);
    s.setCliSettings(1, { autoCompactAt: 200 });
    expect(s.cliSettings(1).autoCompactAt).toBe(95);
  });

  it('applies a partial patch without clobbering the other field', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'm', autoCompact: true });
    s.setCliSettings(1, { model: 'n' });
    expect(s.cliSettings(1)).toEqual({ model: 'n', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '' });
  });

  it('isolates settings per user', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'a' });
    s.setCliSettings(2, { model: 'b' });
    expect(s.cliSettings(1).model).toBe('a');
    expect(s.cliSettings(2).model).toBe('b');
  });

  it('removeForUser drops a user\'s settings', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'a', autoCompact: true });
    s.removeForUser(1);
    expect(s.cliSettings(1)).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '' });
  });

  it('links and reverse-looks-up a Discord id (invalid values clear it)', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { discordUserId: '123456789012345678' });
    expect(s.cliSettings(1).discordUserId).toBe('123456789012345678');
    expect(s.userIdBySetting('discordUserId', '123456789012345678')).toBe(1);
    s.setCliSettings(1, { discordUserId: 'not-a-snowflake' });
    expect(s.cliSettings(1).discordUserId).toBe('');
    expect(s.userIdBySetting('discordUserId', '123456789012345678')).toBeNull();
  });

  it('refuses a Discord id already claimed by another user (no squatting)', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { discordUserId: '123456789012345678' }); // user 1 links it first
    s.setCliSettings(2, { discordUserId: '123456789012345678' }); // user 2 tries to squat
    expect(s.cliSettings(2).discordUserId).toBe('');               // ignored
    expect(s.userIdBySetting('discordUserId', '123456789012345678')).toBe(1); // stays with user 1
    // The original owner can re-set their own link idempotently.
    s.setCliSettings(1, { discordUserId: '123456789012345678' });
    expect(s.cliSettings(1).discordUserId).toBe('123456789012345678');
  });
});
