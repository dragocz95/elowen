import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserSettingStore, DiscordIdConflictError, WhatsAppNumberConflictError, TelegramIdConflictError } from '../../src/store/userSettingStore.js';

describe('UserSettingStore', () => {
  it('defaults CLI settings when nothing is stored', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.cliSettings(1)).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true });
  });

  it('round-trips model + autoCompact + threshold via the typed helper', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true });
    expect(s.cliSettings(1)).toEqual({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 70, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true });
  });

  it('round-trips per-model auto-compact thresholds, clamps them, drops invalid entries, and clears', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    // Values are clamped into the 30–95 band; a non-numeric entry is dropped, not defaulted.
    s.setCliSettings(1, { autoCompactAtByModel: { 'relay/gpt-x': 70, 'ant/claude-x': 200, 'bad/one': Number.NaN as unknown as number } });
    expect(s.cliSettings(1).autoCompactAtByModel).toEqual({ 'relay/gpt-x': 70, 'ant/claude-x': 95 });
    // The map replaces wholesale, so an empty map clears every override.
    s.setCliSettings(1, { autoCompactAtByModel: {} });
    expect(s.cliSettings(1).autoCompactAtByModel).toEqual({});
  });

  it('round-trips the compaction-model override pair and clears it', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { compactModel: 'claude-haiku-4-5', compactModelProvider: 'ant' });
    expect(s.cliSettings(1).compactModel).toBe('claude-haiku-4-5');
    expect(s.cliSettings(1).compactModelProvider).toBe('ant');
    // Empty clears the override (compact on the conversation model).
    s.setCliSettings(1, { compactModel: '', compactModelProvider: '' });
    expect(s.cliSettings(1).compactModel).toBe('');
    expect(s.cliSettings(1).compactModelProvider).toBe('');
  });

  it('round-trips the provider-native max reasoning level', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { thinkingLevel: 'max' });
    expect(s.cliSettings(1).thinkingLevel).toBe('max');
    s.setCliSettings(1, { thinkingLevel: 'off' });
    expect(s.cliSettings(1).thinkingLevel).toBe('off');
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
    expect(s.cliSettings(1)).toEqual({ model: 'n', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: true, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true });
  });

  it('isolates settings per user', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'a' });
    s.setCliSettings(2, { model: 'b' });
    expect(s.cliSettings(1).model).toBe('a');
    expect(s.cliSettings(2).model).toBe('b');
  });

  it('round-trips project model preferences per user and ignores a corrupt map', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.projectModelPreference(1, '/var/www/kolin')).toBeUndefined();
    s.setProjectModelPreference(1, '/var/www/kolin', { provider: 'codex', model: 'gpt-5.5' });
    expect(s.projectModelPreference(1, '/var/www/kolin')).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    expect(s.projectModelPreference(2, '/var/www/kolin')).toBeUndefined();
    s.set(1, 'projectModelPreferences', '{not json');
    expect(s.projectModelPreference(1, '/var/www/kolin')).toBeUndefined();
  });

  it('removeForUser drops a user\'s settings', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { model: 'a', autoCompact: true });
    s.removeForUser(1);
    expect(s.cliSettings(1)).toEqual({ model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '', autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', autoRecall: true, autoSave: true });
  });

  it('terminal settings default, round-trip, merge, and survive a corrupt blob', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.terminalSettings(1).theme).toBe('auto');
    expect(s.terminalSettings(1).fontSize).toBe(12);
    // Round-trip + validation happens in the store.
    const saved = s.setTerminalSettings(1, { theme: 'custom', fontSize: 16, palette: { background: '#123456' } });
    expect(saved.theme).toBe('custom');
    expect(s.terminalSettings(1).fontSize).toBe(16);
    expect(s.terminalSettings(1).palette.background).toBe('#123456');
    // Partial patch merges (fontSize preserved), and per-user isolation holds.
    s.setTerminalSettings(1, { cursorStyle: 'bar' });
    expect(s.terminalSettings(1).fontSize).toBe(16);
    expect(s.terminalSettings(1).cursorStyle).toBe('bar');
    expect(s.terminalSettings(2).theme).toBe('auto');
    // A corrupt stored blob degrades to defaults instead of throwing.
    s.set(1, 'terminal', '{not json');
    expect(s.terminalSettings(1)).toEqual(s.terminalSettings(99));
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

  it('links a WhatsApp number, normalizing to digits, and reverse-looks-it-up', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    // A user may paste "+420 778 433 908"; the store strips it to digits for a stable identity key.
    s.setCliSettings(1, { whatsappNumber: '+420 778 433 908' });
    expect(s.cliSettings(1).whatsappNumber).toBe('420778433908');
    expect(s.userIdBySetting('whatsappNumber', '420778433908')).toBe(1);
    s.setCliSettings(1, { whatsappNumber: '123' }); // too short → clears
    expect(s.cliSettings(1).whatsappNumber).toBe('');
    expect(s.userIdBySetting('whatsappNumber', '420778433908')).toBeNull();
  });

  it('refuses a WhatsApp number already claimed by another user (no squatting)', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { whatsappNumber: '420778433908' });
    expect(() => s.setCliSettings(2, { whatsappNumber: '420778433908' })).toThrow(WhatsAppNumberConflictError);
    expect(s.cliSettings(2).whatsappNumber).toBe('');
    expect(s.userIdBySetting('whatsappNumber', '420778433908')).toBe(1);
  });

  it('links a Telegram numeric user id and reverse-looks-it-up; too-short clears', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { telegramUserId: '123456789' });
    expect(s.cliSettings(1).telegramUserId).toBe('123456789');
    expect(s.userIdBySetting('telegramUserId', '123456789')).toBe(1);
    s.setCliSettings(1, { telegramUserId: '12' }); // too short → clears
    expect(s.cliSettings(1).telegramUserId).toBe('');
    expect(s.userIdBySetting('telegramUserId', '123456789')).toBeNull();
  });

  it('refuses a Telegram id already claimed by another user (no squatting)', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setCliSettings(1, { telegramUserId: '123456789' });
    expect(() => s.setCliSettings(2, { telegramUserId: '123456789' })).toThrow(TelegramIdConflictError);
    expect(s.cliSettings(2).telegramUserId).toBe('');
    expect(s.userIdBySetting('telegramUserId', '123456789')).toBe(1);
  });

  it('permission settings: empty defaults, sanitized round-trip, corrupt blob degrades cleanly', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    expect(s.permissionSettings(1)).toEqual({ tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' });
    s.setPermissionSettings(1, { tools: { Write: 'allow', junk: 'nuke' }, bash: { 'rm *': 'deny' }, yolo: true, unattendedAsks: 'deny' });
    expect(s.permissionSettings(1)).toEqual({ tools: { Write: 'allow' }, bash: { 'rm *': 'deny' }, yolo: true, unattendedAsks: 'deny' });
    // A patch replaces a present rule map wholesale but keeps absent fields (yolo + strict mode stay).
    s.setPermissionSettings(1, { bash: { 'git *': 'allow' } });
    expect(s.permissionSettings(1)).toEqual({ tools: { Write: 'allow' }, bash: { 'git *': 'allow' }, yolo: true, unattendedAsks: 'deny' });
    // Corrupt stored JSON → full defaults, never a throw.
    s.set(1, 'permissions', '{not json');
    expect(s.permissionSettings(1)).toEqual({ tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' });
  });

  it('addPermissionAllowRule appends (or moves) the pattern to the END so it wins last-match resolution', () => {
    const s = new UserSettingStore(openDb(':memory:'));
    s.setPermissionSettings(1, { bash: { 'npm *': 'deny', 'git *': 'ask' } });
    s.addPermissionAllowRule(1, 'bash', 'npm *'); // an "Always allow" pick overrides the earlier deny
    expect(Object.entries(s.permissionSettings(1).bash)).toEqual([['git *', 'ask'], ['npm *', 'allow']]);
    s.addPermissionAllowRule(1, 'tools', 'Write');
    expect(s.permissionSettings(1).tools).toEqual({ Write: 'allow' });
  });
});
