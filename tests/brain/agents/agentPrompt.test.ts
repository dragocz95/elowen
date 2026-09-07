import { describe, it, expect } from 'vitest';
import { renderAgentPrompt } from '../../../src/brain/agents/agentPrompt.js';

describe('renderAgentPrompt', () => {
  it('substitutes the tool-name placeholders with Elowen tool names', () => {
    expect(renderAgentPrompt('Use ${GREP_TOOL_NAME} and ${READ_TOOL_NAME} and ${SHELL_TOOL_NAME}'))
      .toBe('Use Search and Read and Bash');
    // Name patterns belong to Glob and contents to Search, the same split the reference draws.
    expect(renderAgentPrompt('${GLOB_TOOL_NAME} ${FIND_TOOL_NAME} ${CODEBASE_TOOL_NAME} ${LS_TOOL_NAME} ${EDIT_TOOL_NAME}'))
      .toBe('Glob Glob CodebaseSearch ListDir Edit');
  });

  it('resolves the environment conditionals to their bash / embedded branch', () => {
    expect(renderAgentPrompt('(${IS_BASH_ENV_FN?ls, cat, grep:Get-ChildItem, Get-Content})'))
      .toBe('(ls, cat, grep)');
    expect(renderAgentPrompt('${USE_EMBEDDED_TOOLS_FN?embedded tools:external cli}'))
      .toBe('embedded tools');
  });

  it('leaves an unknown placeholder untouched so a typo is visible, not blanked', () => {
    expect(renderAgentPrompt('${MYSTERY_TOKEN} stays')).toBe('${MYSTERY_TOKEN} stays');
  });
});
