import { describe, it, expect, beforeAll } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { UserBlock, StatusBar, TitleBar, CardPanel, metaLine, banner, toolChip, diffBlock, cardBlock, titleBarContent, fmtCount } from '../../../src/cli/chat/components.js';

describe('chat components', () => {
  beforeAll(() => { initTheme(); }); // renderDiff needs the pi theme
  it('UserBlock renders full-width rows with a left rail and padding', () => {
    const lines = new UserBlock('ahoj').render(20);
    // blank top, one text row, blank bottom
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(visibleWidth(l)).toBe(20); // every row fills the width
    expect(lines[1]).toContain('ahoj');
  });

  it('StatusBar justifies left and right to the edges', () => {
    const [line] = new StatusBar('L', 'R').render(10);
    expect(visibleWidth(line!)).toBe(10);
    expect(line!.startsWith('L')).toBe(true);
    expect(line!.endsWith('R')).toBe(true);
  });

  it('metaLine shows the model (no speaker label)', () => {
    const m = metaLine('kimi');
    expect(m).toContain('kimi');
    expect(m).not.toContain('orca');
  });

  it('TitleBar fills the width with a background and justifies left/right', () => {
    const tb = new TitleBar();
    tb.set('L', 'R');
    const [line] = tb.render(20);
    expect(visibleWidth(line!)).toBe(20);
    expect(line!).toContain('L');
    expect(line!).toContain('R');
  });

  it('titleBarContent puts the title left and usage stats right', () => {
    const { left, right } = titleBarContent('Můj task', { totalTokens: 39413, percent: 20, cost: 0.29 });
    expect(left).toContain('Můj task');
    expect(right).toContain('39,413');
    expect(right).toContain('20%');
    expect(right).toContain('$0.29');
  });

  it('titleBarContent without usage shows just the title', () => {
    const { left, right } = titleBarContent('X', null);
    expect(left).toContain('X');
    expect(right).toBe('');
  });

  it('fmtCount groups thousands', () => {
    expect(fmtCount(39413)).toBe('39,413');
  });

  it('diffBlock renders the pi format via renderDiff and the legacy format with row colors', () => {
    const pi = diffBlock('-    2 line two\n+    2 line 2');
    expect(pi.join('\n')).toContain('line two');
    expect(pi.join('\n')).toContain('line 2');
    const legacy = diffBlock('   2 - old\n   2 + new');
    expect(legacy[0]).toContain('old');
    expect(legacy[1]).toContain('new');
  });

  it('diffBlock caps long diffs with a more-lines note', () => {
    const diff = Array.from({ length: 70 }, (_, i) => `+ ${String(i + 1).padStart(4)} row`).join('\n');
    const out = diffBlock(diff);
    expect(out).toHaveLength(61);
    expect(out[60]).toContain('+10 more lines');
  });

  it('toolChip renders Claude-Code style: dot, name, args in parens', () => {
    expect(toolChip('web_search')).toContain('⏺');
    expect(toolChip('web_search')).toContain('web_search');
    expect(toolChip('read_file', 'src/a.ts')).toContain('(src/a.ts)');
  });

  it('toolChip renders the daemon-provided icon, else the generic dot', () => {
    // The per-tool icon now rides the tool event (resolved daemon-side from the core map + plugin
    // manifest icons); toolChip just renders it, falling back to ⏺ when none was provided (e.g. history).
    expect(toolChip('todo_write', undefined, '📋')).toContain('📋');
    expect(toolChip('todo_write', undefined, '📋')).not.toContain('⏺');
    expect(toolChip('todo_write')).toContain('⏺'); // no icon (reloaded history) → generic dot
  });

  it('CardPanel renders pinned cards as real rows and collapses an all-done checklist / non-pinned cards', () => {
    const panel = new CardPanel();
    expect(panel.render(80)).toEqual([]); // no cards → the panel disappears from the fixed stack
    panel.set([{ id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'One', status: 'pending' }, { text: 'Two', status: 'completed' }] }]);
    const lines = panel.render(80);
    expect(lines.length).toBe(3); // header + 2 rows, as separate lines (not one \n-joined string)
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    // A non-pinned card never enters the fixed panel.
    panel.set([{ id: 'x', pinned: false, items: [{ text: 'One', status: 'pending' }] }]);
    expect(panel.render(80)).toEqual([]);
    // Everything completed → the work is done, so the checklist card collapses.
    panel.set([{ id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'One', status: 'completed' }] }]);
    expect(panel.render(80)).toEqual([]);
  });

  it('cardBlock renders a title, header count and per-status glyphs plus an optional body', () => {
    const out = cardBlock({
      id: 'todos', title: 'Todos',
      items: [
        { text: 'Alpha', status: 'completed' },
        { text: 'Beta', status: 'in_progress' },
        { text: 'Gamma', status: 'pending' },
      ],
      body: 'note line',
    });
    expect(out[0]).toContain('Todos');
    expect(out[0]).toContain('1/3');
    const body = out.join('\n');
    expect(body).toContain('✔'); // completed
    expect(body).toContain('◐'); // in-progress
    expect(body).toContain('○'); // pending
    expect(body).toContain('Alpha');
    expect(body).toContain('note line');
  });

  it('banner renders the ORCA block-letter logo and the model', () => {
    const lines = banner('opus');
    expect(lines.some((l) => l.includes('█'))).toBe(true); // block-letter art
    expect(lines.join('\n')).toContain('opus');
    expect(lines.join('\n')).toContain('/help for commands');
  });
});
