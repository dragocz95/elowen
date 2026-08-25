import { describe, it, expect } from 'vitest';
import { toolIcon, shortToolName } from '../../lib/toolMeta';

/** The feed draws tools in one flat colour, so the icon is the ONLY thing separating a read from a
 *  shell command. These pin that tools which do different things look different, and that unknown
 *  tools degrade honestly — not which specific glyph any one tool gets, which is presentation. */

describe('toolIcon', () => {
  it('gives reading, writing and the shell distinct marks', () => {
    const icons = [toolIcon('Read'), toolIcon('Edit'), toolIcon('Bash')];
    expect(new Set(icons).size).toBe(3);
  });

  it('shares one mark between tools that do the same thing', () => {
    // Grep and Search are both a text search; a reader gains nothing from telling them apart.
    expect(toolIcon('Grep')).toBe(toolIcon('Search'));
    expect(toolIcon('Bash')).toBe(toolIcon('ProcessOutput'));
  });

  it('separates browser acts so a run of them still reads as distinct steps', () => {
    const shot = toolIcon('mcp__chrome_devtools__take_screenshot');
    const click = toolIcon('mcp__chrome_devtools__click');
    const nav = toolIcon('mcp__chrome_devtools__navigate_page');
    expect(new Set([shot, click, nav]).size).toBe(3);
  });

  it('falls back to a neutral mark rather than guessing at an unknown tool', () => {
    const unknown = toolIcon('SomeFutureTool');
    expect(unknown).toBeTruthy();
    // A guess would be worse than an honest generic: it must not borrow a real tool's identity.
    expect(unknown).not.toBe(toolIcon('Bash'));
    expect(unknown).not.toBe(toolIcon('Read'));
  });

  it('routes tool families by prefix when the exact name is unlisted', () => {
    expect(toolIcon('DelegateSomethingNew')).toBe(toolIcon('Delegate'));
    expect(toolIcon('MemorySomethingNew')).toBe(toolIcon('MemoryAdd'));
    expect(toolIcon('TaskSomethingNew')).toBe(toolIcon('TaskList'));
  });

  it('gives an unnamespaced MCP tool a mark without pretending to know it', () => {
    expect(toolIcon('mcp__something__never_seen_before')).toBeTruthy();
  });
});

describe('shortToolName', () => {
  it('drops the MCP namespace', () => {
    expect(shortToolName('mcp__chrome_devtools__take_screenshot')).toBe('take_screenshot');
  });

  it('leaves an ordinary tool name alone', () => {
    expect(shortToolName('Bash')).toBe('Bash');
  });
});
