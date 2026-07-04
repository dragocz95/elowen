import { describe, it, expect } from 'vitest';
import { makeToolIconResolver } from '../../src/brain/toolIcons.js';
import { BUILTIN_TOOL_ICONS } from '../../src/brain/tools/index.js';

/** Assemble the resolver the way BrainService does: built-in icons overlaid with plugin manifest icons. */
function resolver(pluginIcons: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(BUILTIN_TOOL_ICONS));
  for (const [k, v] of Object.entries(pluginIcons)) map.set(k, v);
  return makeToolIconResolver(map);
}

describe('makeToolIconResolver — the single tool→icon source', () => {
  it('resolves built-in tools by prefix (orca_*, memory_*)', () => {
    const r = resolver();
    expect(r('orca_list_tasks')).toBe('🐋');
    expect(r('memory_search')).toBe('🧠');
  });

  it('resolves plugin manifest icons — exact and prefix', () => {
    const r = resolver({ ask_user_question: '❓', 'discord_*': '💬' });
    expect(r('ask_user_question')).toBe('❓');
    expect(r('discord_list_channels')).toBe('💬');
  });

  it('an exact entry wins over a prefix entry', () => {
    const r = resolver({ 'todo_*': '📋', todo_write: '✅' });
    expect(r('todo_write')).toBe('✅');
    expect(r('todo_read')).toBe('📋');
  });

  it('a plugin entry overrides a built-in for the same key', () => {
    const r = resolver({ 'orca_*': '🎯' });
    expect(r('orca_plan')).toBe('🎯');
  });

  it('returns undefined for an unknown tool (client applies its own generic glyph)', () => {
    expect(resolver()('totally_unknown')).toBeUndefined();
  });
});
