import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { ChatEditor, sessionItems, modelItems, openPicker, parseModelValue, pickerContentWidth } from '../../../src/cli/chat/picker.js';

describe('pickerContentWidth (adaptive modal sizing)', () => {
  it('grows with long descriptions and stays compact for short lists', () => {
    const short = pickerContentWidth([{ value: 'a', label: 'elowen', description: 'x' }], 'Theme');
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

  it('auto-grows through six content rows and scrolls internally beyond that cap', () => {
    const editor = makeEditor();
    editor.focused = true;

    editor.setText('one');
    expect(editor.render(40)).toHaveLength(3); // top rule + one content row + bottom rule

    editor.setText(Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join('\n'));
    expect(editor.render(40)).toHaveLength(8); // six content rows + the two rules

    editor.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'));
    const capped = editor.render(40);
    expect(capped).toHaveLength(8);
    expect(capped.join('\n')).toContain('line 12');
    expect(capped.join('\n')).not.toContain('line 1\n');
  });

  it('keeps the cursor-visible explicit line while moving through a long draft', () => {
    const editor = makeEditor();
    editor.focused = true;
    editor.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'));

    for (let index = 0; index < 9; index += 1) press(editor, UP);
    const rendered = editor.render(40).join('\n');
    expect(editor.getCursor().line).toBe(2);
    expect(rendered).toContain('line 3');
    expect(rendered).toContain('\x1b[7m');
    expect(rendered).not.toContain('line 12');
  });

  it('follows the cursor across wrapped rows and a terminal resize', () => {
    const editor = makeEditor();
    editor.focused = true;
    editor.setText('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima');

    const narrowBottom = editor.render(16);
    expect(narrowBottom).toHaveLength(8); // six wrapped rows at this width + rules
    expect(narrowBottom.join('\n')).toContain('\x1b[7m');

    for (let index = 0; index < 3; index += 1) {
      editor.render(16);
      editor.handleInput(UP);
    }
    const narrowTop = editor.render(16).join('\n');
    expect(narrowTop).toContain('\x1b[7m');
    expect(narrowTop).toContain('alpha');

    const wide = editor.render(60);
    expect(wide.length).toBeLessThanOrEqual(8);
    expect(wide.join('\n')).toContain('\x1b[7m');
  });

  it('obeys a smaller central layout allocation without losing the cursor', () => {
    const editor = makeEditor();
    editor.focused = true;
    editor.setText(Array.from({ length: 8 }, (_, index) => `draft ${index + 1}`).join('\n'));
    editor.setMaxRows(4); // two content rows plus the editor rules on a short terminal

    expect(editor.render(40)).toHaveLength(4);
    press(editor, UP);
    const rendered = editor.render(40);
    expect(rendered).toHaveLength(4);
    expect(rendered.join('\n')).toContain('\x1b[7m');
  });

  it('submits multiline text once, clears the viewport, and keeps history boundaries intact', () => {
    const editor = makeEditor();
    const submitted: string[] = [];
    editor.onSubmit = (text) => submitted.push(text);
    editor.setText('first\nsecond');
    press(editor, '\r');
    expect(submitted).toEqual(['first\nsecond']);
    expect(editor.getText()).toBe('');
    expect(editor.render(40)).toHaveLength(3);

    editor.addToHistory('older');
    press(editor, UP);
    expect(editor.getText()).toBe('older');
    press(editor, DOWN);
    expect(editor.getText()).toBe('');
    press(editor, DOWN);
    expect(editor.getText()).toBe('');
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

describe('picker overlay lifecycle', () => {
  beforeAll(() => { initTheme(); });

  it('gives the overlay input focus and restores the unchanged editor when Esc closes it', () => {
    let overlay!: Component;
    const hide = vi.fn();
    const focus = vi.fn();
    const setFocus = vi.fn();
    const requestRender = vi.fn();
    const tui = {
      terminal: { rows: 24, columns: 100 },
      showOverlay: (component: Component) => {
        overlay = component;
        return { hide, focus, isHidden: () => false, setHidden: () => {} };
      },
      setFocus,
      requestRender,
    } as unknown as TUI;
    const editor = new ChatEditor(tui, { borderColor: (text) => text, selectList: getSelectListTheme() }, {});
    editor.setText('keep this unfinished draft');

    openPicker({
      tui,
      editor,
      items: [{ value: 'one', label: 'One' }],
      title: 'Choose',
      onPick: vi.fn(),
    });
    expect(focus).toHaveBeenCalledOnce();

    overlay.handleInput?.('\x1b');
    expect(hide).toHaveBeenCalledOnce();
    expect(setFocus).toHaveBeenCalledWith(editor);
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(editor.getText()).toBe('keep this unfinished draft');
  });
});
