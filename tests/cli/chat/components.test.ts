import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { UserBlock, StatusBar, TitleBar, metaLine, banner, toolChip, titleBarContent, fmtCount } from '../../../src/cli/chat/components.js';

describe('chat components', () => {
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

  it('toolChip shows the tool name with a glyph (star for search, arrow for reads)', () => {
    expect(toolChip('web_search')).toContain('* web_search');
    expect(toolChip('read_file')).toContain('→ read_file');
  });

  it('banner renders a bordered box with the brand and model', () => {
    const lines = banner('opus');
    expect(lines.join('\n')).toContain('Orca AI');
    expect(lines.join('\n')).toContain('opus');
    expect(lines.some((l) => l.includes('╭'))).toBe(true);
    expect(lines.some((l) => l.includes('╰'))).toBe(true);
  });
});
