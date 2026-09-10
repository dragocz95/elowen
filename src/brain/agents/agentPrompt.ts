/**
 * Render an agent definition's prompt body: substitute the tool-name placeholders (`${GREP_TOOL_NAME}`
 * …) that the Amp/Claude-Code prompt format uses with Elowen's own tool names, and resolve the
 * environment conditionals to the branch that matches Elowen's runtime. This lets a prompt author (built-in
 * or a user's own `.md`) write portable prompts without hard-coding our tool names, and keeps the built-in
 * explore/plan/review prompts readable rather than pre-substituted.
 */

/** Placeholder → Elowen tool name. Truth is `src/store/toolRenames.ts` (the snake_case → TitleCase map).
 *  The name/content split mirrors the reference's: Glob owns file-name patterns, Search and Grep own
 *  contents. Unknown placeholders are left untouched so a typo is visible rather than silently blanked. */
const TOOL_NAME_TOKENS: Readonly<Record<string, string>> = {
  GREP_TOOL_NAME: 'Search',
  GLOB_TOOL_NAME: 'Glob',
  FIND_TOOL_NAME: 'Glob',
  SEARCH_TOOL_NAME: 'Search',
  SHELL_TOOL_NAME: 'Bash',
  BASH_TOOL_NAME: 'Bash',
  READ_TOOL_NAME: 'Read',
  EDIT_TOOL_NAME: 'Edit',
  WRITE_TOOL_NAME: 'Write',
  LS_TOOL_NAME: 'ListDir',
  CODEBASE_TOOL_NAME: 'CodebaseSearch',
};

/** Elowen always runs a POSIX shell (Linux/bash) with its own embedded search/read tools, so both
 *  environment conditionals resolve to their FIRST branch. Kept as a substitution (rather than
 *  pre-resolving the built-in prompts) so a portable prompt authored elsewhere still renders correctly.
 *  The `[^{}]` branch bodies deliberately do not span nested `${…}` — built-in prompts avoid nesting. */
const ENV_CONDITIONALS: readonly RegExp[] = [
  /\$\{IS_BASH_ENV_FN\?([^{}]*?):[^{}]*?\}/g,
  /\$\{USE_EMBEDDED_TOOLS_FN\?([^{}]*?):[^{}]*?\}/g,
];

export function renderAgentPrompt(body: string): string {
  let out = body;
  for (const rx of ENV_CONDITIONALS) out = out.replace(rx, '$1');
  return out.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, token: string) => TOOL_NAME_TOKENS[token] ?? whole);
}
