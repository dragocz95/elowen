import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { UserBlock, StatusBar, metaLine, banner, toolChip } from '../../../src/cli/chat/components.js';

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

  it('metaLine includes orca, the model and a duration', () => {
    const m = metaLine('kimi', 5200);
    expect(m).toContain('orca');
    expect(m).toContain('kimi');
    expect(m).toContain('5.2s');
  });

  it('toolChip shows the tool name with the dot glyph', () => {
    const c = toolChip('web_search');
    expect(c).toContain('web_search');
    expect(c).toContain('⏺');
  });

  it('banner renders a bordered box with the brand and model', () => {
    const lines = banner('opus');
    expect(lines.join('\n')).toContain('Orca AI');
    expect(lines.join('\n')).toContain('opus');
    expect(lines.some((l) => l.includes('╭'))).toBe(true);
    expect(lines.some((l) => l.includes('╰'))).toBe(true);
  });
});
