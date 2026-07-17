import { describe, it, expect } from 'vitest';
import { makeToolOutputPolicy } from '../../src/brain/toolOutput.js';
import { BUILTIN_TOOL_OUTPUT_SHOWN } from '../../src/brain/tools/index.js';

describe('makeToolOutputPolicy', () => {
  it('shows on an exact tool-name match, hides everything else', () => {
    const shown = makeToolOutputPolicy(() => ['Bash', 'ProcessOutput']);
    expect(shown('Bash')).toBe(true);
    expect(shown('ProcessOutput')).toBe(true);
    expect(shown('Read')).toBe(false);
  });

  it('shows on a prefix* pattern', () => {
    const shown = makeToolOutputPolicy(() => ['Lsp*']);
    expect(shown('LspDiagnostics')).toBe(true);
    expect(shown('LspHover')).toBe(true);
    // Case-sensitive by design: a family glob covers OUR tools, and must not sweep in a third-party
    // plugin's same-prefix snake_case tool (they are still named that way) or a bridged mcp__* one.
    expect(shown('lsp_hover')).toBe(false);
    expect(shown('mcp__github__search')).toBe(false);
  });

  it('merges built-in defaults with plugin patterns and reads the set live', () => {
    let pluginPatterns: string[] = [];
    const shown = makeToolOutputPolicy(() => [...BUILTIN_TOOL_OUTPUT_SHOWN, ...pluginPatterns]);
    // Built-in defaults: Lsp* shown; Elowen*/Memory* deliberately hidden (not on the allowlist).
    expect(shown('LspDiagnostics')).toBe(true);
    expect(shown('ElowenListTasks')).toBe(false);
    expect(shown('MemorySearch')).toBe(false);
    // A plugin's tool stays hidden until its patterns land — then shown without a rebuild (live thunk).
    expect(shown('Bash')).toBe(false);
    pluginPatterns = ['Bash'];
    expect(shown('Bash')).toBe(true);
  });

  it('an empty policy shows nothing', () => {
    const shown = makeToolOutputPolicy(() => []);
    expect(shown('anything')).toBe(false);
  });
});
