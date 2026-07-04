import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserSettingStore, DiscordIdConflictError } from '../../src/store/userSettingStore.js';

describe('UserSettingStore', () => {
  it('defaults CLI settings when nothing is stored', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.cliSettings(1)).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true });
  });

  it('round-trips model + autoCompact + threshold via the typed helper', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true });
    expect(s.cliSettings(1)).toEqual({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true });
  });

  it('memory autoRecall/autoSave default on and round-trip false', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.cliSettings(1).autoRecall).toBe(true);
    expect(s.cliSettings(1).autoSave).toBe(true);
    s.setCliSettings(1, { autoRecall: false, autoSave: false });
    expect(s.cliSettings(1).autoRecall).toBe(false);
    expect(s.cliSettings(1).autoSave).toBe(false);
    // A partial patch touching only autoSave leaves autoRecall as previously stored.
    s.setCliSettings(1, { autoRecall: true });
    expect(s.cliSettings(1).autoRecall).toBe(true);
    expect(s.cliSettings(1).autoSave).toBe(false);
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
    expect(s.cliSettings(1)).toEqual({ model: 'n', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true });
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
    expect(s.cliSettings(1)).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '', autoRecall: true, autoSave: true });
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
    // user 2 tries to squat → rejected with a typed conflict, the link stays with user 1
    expect(() => s.setCliSettings(2, { discordUserId: '123456789012345678' })).toThrow(DiscordIdConflictError);
    expect(s.cliSettings(2).discordUserId).toBe('');
    expect(s.userIdBySetting('discordUserId', '123456789012345678')).toBe(1);
    // The original owner can re-set their own link idempotently.
    s.setCliSettings(1, { discordUserId: '123456789012345678' });
    expect(s.cliSettings(1).discordUserId).toBe('123456789012345678');
  });

  it('rolls the whole patch back when the Discord link is rejected (no partial write)', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { discordUserId: '123456789012345678' }); // user 1 owns the snowflake
    // user 2's patch bundles a model change with a squatting Discord id — the conflict must undo both.
    expect(() => s.setCliSettings(2, { model: 'squat-model', discordUserId: '123456789012345678' }))
      .toThrow(DiscordIdConflictError);
    expect(s.cliSettings(2).model).toBe('');
    expect(s.cliSettings(2).discordUserId).toBe('');
  });
});
