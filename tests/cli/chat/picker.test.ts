import { beforeAll, describe, it, expect } from 'vitest';
import type { TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { ChatEditor, sessionItems, modelItems, parseModelValue, pickerContentWidth } from '../../../src/cli/chat/picker.js';

describe('pickerContentWidth (adaptive modal sizing)', () => {
  it('grows with long descriptions and stays compact for short lists', () => {
    const short = pickerContentWidth([{ value: 'a', label: 'orca', description: 'x' }], 'Theme');
    const hint = 'not installed · ctrl+i installs (npm install -g typescript-language-server typescript)';
    const long = pickerContentWidth([{ value: 'b', label: 'TypeScript', description: hint }], 'LSP');
    expect(short).toBeLessThan(60);
    expect(long).toBeGreaterThan(hint.length); // the whole hint fits
  });
});

describe('picker item builders', () => {
  it('sessionItems marks the active conversation and falls back to (untitled)', () => {
    const items = sessionItems([
      { id: 'a', title: 'Fix the button', model: 'opus', updated_at: '2026-07-02T12:00:00', active: true },
      { id: 'b', title: '', model: 'kimi', updated_at: '', active: false },
    ]);
    expect(items[0]).toMatchObject({ value: 'a', label: '▸ Fix the button' });
    expect(items[0]!.description).toContain('opus');
    expect(items[0]!.description).toContain('2026-07-02');
    expect(items[1]).toMatchObject({ value: 'b', label: '(untitled)', description: 'kimi' });
  });

  it('modelItems floats the current model to the top and encodes provider+model in the value', () => {
    const items = modelItems([
      { provider: 'relay', providerLabel: 'Relay', model: 'kimi' },
      { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4-8' },
    ], 'claude-opus-4-8');
    expect(items[0]).toMatchObject({ value: 'anthropic claude-opus-4-8', label: '▸ claude-opus-4-8', description: 'Anthropic' });
    expect(items[1]).toMatchObject({ value: 'relay kimi', label: 'kimi' });
  });

  it('parseModelValue splits the picker value back into a selection', () => {
    expect(parseModelValue('relay kimi')).toEqual({ provider: 'relay', model: 'kimi' });
  });
});

describe('ChatEditor input history recall', () => {
  beforeAll(() => { initTheme(); }); // getSelectListTheme needs the pi theme

  const UP = '\x1b[A';
  const DOWN = '\x1b[B';
  const makeEditor = (): ChatEditor => {
    const tui = { requestRender: () => { /* not rendering */ }, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
    return new ChatEditor(tui, { borderColor: (s) => s, selectList: getSelectListTheme() }, {});
  };
  // The editor lays out against its last render width; keep it current like the TUI render loop does.
  const press = (editor: ChatEditor, data: string): void => { editor.render(60); editor.handleInput(data); };

  it('recalls sent messages with Up from an empty editor and walks back down to the empty draft', () => {
    const editor = makeEditor();
    editor.addToHistory('first message');
    editor.addToHistory('second message');
    press(editor, UP);
    expect(editor.getText()).toBe('second message');
    press(editor, UP);
    expect(editor.getText()).toBe('first message');
    press(editor, UP); // already at the oldest entry — stays put
    expect(editor.getText()).toBe('first message');
    press(editor, DOWN);
    expect(editor.getText()).toBe('second message');
    press(editor, DOWN); // past the newest — restores the empty draft
    expect(editor.getText()).toBe('');
  });

  it('keeps Up/Down as line navigation inside a multi-line draft', () => {
    const editor = makeEditor();
    editor.addToHistory('older entry');
    editor.setText('line one\nline two');
    press(editor, UP); // cursor moves up a line instead of recalling history
    expect(editor.getText()).toBe('line one\nline two');
    press(editor, DOWN);
    expect(editor.getText()).toBe('line one\nline two');
  });

  it('drops out of history mode once a recalled entry is edited', () => {
    const editor = makeEditor();
    editor.addToHistory('recalled');
    press(editor, UP);
    expect(editor.getText()).toBe('recalled');
    press(editor, 'x'); // editing exits history browsing (cursor sits at the start after recall)
    expect(editor.getText()).toBe('xrecalled');
    press(editor, DOWN); // no longer recalling → the edit is an ordinary draft and is kept
    expect(editor.getText()).toBe('xrecalled');
  });
});
