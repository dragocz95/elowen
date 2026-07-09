import { describe, expect, it } from 'vitest';
import { compactNotice } from '../../../src/cli/chat/commands.js';

describe('compactNotice', () => {
  it('a real compaction shows no local notice — the daemon stream owns the status', () => {
    expect(compactNotice({ compacted: true })).toBeNull();
    expect(compactNotice({ compacted: true, message: 'ignored' })).toBeNull();
  });

  it('a benign no-op surfaces the server message (it emits no stream event to announce itself)', () => {
    expect(compactNotice({ compacted: false, message: 'Nothing to compact yet.' })).toBe('Nothing to compact yet.');
  });

  it('a no-op with no server message falls back to a default so the command never looks silent', () => {
    expect(compactNotice({ compacted: false })).toBe('Nothing to compact yet.');
  });
});
