// dev-commands plugin: a curated set of opencode-style custom slash commands, contributed to every chat
// surface via ctx.registerCommand. Each command is a prompt macro — invoking `/name <args>` sends its
// prompt to the agent with `$ARGS` (and `$1..$9`) substituted. Pure declarative content: no tools, no
// network, no state. Opt-in (not enabled by default); the operator picks which commands to expose.

/** The full catalogue. `prompt` supports `$ARGS` (everything typed after the command). */
const COMMANDS = [
  {
    name: 'commit',
    description: 'Stage the relevant changes and write a Conventional Commits message',
    prompt: 'Review the current working-tree changes, stage the relevant files, and write a Conventional Commits message describing what changed and why. Show me the staged diff summary and the proposed message BEFORE committing, and wait for my confirmation. Extra guidance: $ARGS',
  },
  {
    name: 'review',
    description: 'Review the current diff for bugs, security issues and style',
    prompt: 'Review the current diff (git diff; if it is empty, review the last commit) for correctness bugs, security issues, and style problems. Report findings ranked by severity, each with a concrete file:line and a one-line fix suggestion. Scope/notes: $ARGS',
  },
  {
    name: 'test',
    description: 'Run the test suite and fix any failures',
    prompt: 'Run the project\'s test suite. If anything fails, diagnose the root cause and fix it (no workarounds), then re-run until green, explaining each fix. Target or extra args: $ARGS',
  },
  {
    name: 'explain',
    description: 'Explain how something works in this codebase',
    prompt: 'Explain how the following works in THIS codebase — its purpose, inputs/outputs, the key call sites, and any non-obvious gotchas. Read the relevant files first; cite file:line. Subject: $ARGS',
  },
  {
    name: 'pr',
    description: 'Write a pull-request description for this branch',
    prompt: 'Compare this branch against the main branch and write a clear pull-request description: a concise title, a summary of what changed and why, and a test plan. Do not push or open anything — just produce the text. Extra context: $ARGS',
  },
  {
    name: 'docs',
    description: 'Write or update documentation to match the code',
    prompt: 'Write or update the documentation for the following so it matches the current implementation. Keep it concise and accurate; update examples that have drifted. Target: $ARGS',
  },
  {
    name: 'refactor',
    description: 'Refactor for clarity without changing behavior',
    prompt: 'Refactor the following for clarity and maintainability WITHOUT changing behavior. Keep the diff minimal and focused, preserve the public interface, and explain each improvement. Run the tests afterwards to prove behavior is unchanged. Target: $ARGS',
  },
];

export function register(ctx) {
  const wanted = Array.isArray(ctx.config?.enabled) ? ctx.config.enabled.filter((v) => typeof v === 'string') : [];
  // Empty selection = enable them all (a freshly enabled plugin with no config is immediately useful).
  const chosen = wanted.length ? COMMANDS.filter((c) => wanted.includes(c.name)) : COMMANDS;
  for (const cmd of chosen) ctx.registerCommand(cmd);
  ctx.logger.info(`registered ${chosen.length} developer command(s)`);
}
