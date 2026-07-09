import { describe, it, expect } from 'vitest';
import { makeToolOutputPolicy } from '../../src/brain/toolOutput.js';
import { BUILTIN_TOOL_OUTPUT_SHOWN } from '../../src/brain/tools/index.js';

describe('makeToolOutputPolicy', () => {
  it('shows on an exact tool-name match, hides everything else', () => {
    const shown = makeToolOutputPolicy(() => ['run_command', 'read_process_output']);
    expect(shown('run_command')).toBe(true);
    expect(shown('read_process_output')).toBe(true);
    expect(shown('read_file')).toBe(false);
  });

  it('shows on a prefix* pattern', () => {
    const shown = makeToolOutputPolicy(() => ['lsp_*']);
    expect(shown('lsp_diagnostics')).toBe(true);
    expect(shown('lsp_hover')).toBe(true);
    expect(shown('mcp_github_search')).toBe(false);
  });

  it('merges built-in defaults with plugin patterns and reads the set live', () => {
    let pluginPatterns: string[] = [];
    const shown = makeToolOutputPolicy(() => [...BUILTIN_TOOL_OUTPUT_SHOWN, ...pluginPatterns]);
    // Built-in defaults: lsp_* shown; elowen_*/memory_* deliberately hidden (not on the allowlist).
    expect(shown('lsp_diagnostics')).toBe(true);
    expect(shown('elowen_list_tasks')).toBe(false);
    expect(shown('memory_search')).toBe(false);
    // A plugin's tool stays hidden until its patterns land — then shown without a rebuild (live thunk).
    expect(shown('run_command')).toBe(false);
    pluginPatterns = ['run_command'];
    expect(shown('run_command')).toBe(true);
  });

  it('an empty policy shows nothing', () => {
    const shown = makeToolOutputPolicy(() => []);
    expect(shown('anything')).toBe(false);
  });
});
