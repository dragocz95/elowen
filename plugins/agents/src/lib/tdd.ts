/** THE single source of truth for the TDD directive injected into worker preambles when the operator
 *  turns on TDD mission mode (Settings → Autopilot, or the `/tdd` CLI command). Both worker render paths
 *  — the CLI-spawned workers (commandBuilder) and the embedded brain worker (brainWorker) — import
 *  `tddDirective` and APPEND its result to the rendered preamble, OUTSIDE the template substitution.
 *  There is deliberately no `{{tddDirective}}` placeholder: a user's saved wholesale prompt override
 *  (edited before TDD mode existed) would omit it and silently drop the directive. Appending at the
 *  spawn seam makes the directive independent of the template, so an override can never break it, and
 *  keeps the wording in ONE place so the two paths can never drift. English is correct here: these are
 *  agent-facing operational instructions, not user chrome. */

/** The instruction block appended to a worker prompt when TDD mission mode is on. */
export const TDD_DIRECTIVE = `## Test-Driven Development (required)
You MUST follow strict TDD for every behavioral change:
1. Write a test that captures the desired behavior and confirm it FAILS for the right reason before writing any implementation.
2. Implement the minimum code to make that test pass.
3. Re-run the test(s) and confirm they pass; refactor only with tests green.
Do not write implementation before a failing test exists. If a change has no runtime surface to test (pure docs/config), say so in your summary. Never weaken or delete a test to make it pass.`;

/** Map the TDD-mode flag to the block appended to a worker preamble. Off → empty string (append is a
 *  no-op, so the off-state preamble is byte-identical to a preamble with no TDD mode at all). On → the
 *  directive prefixed with a blank-line gap, so it reads as its own section after the preamble body. */
export function tddDirective(on: boolean): string {
  return on ? `\n\n${TDD_DIRECTIVE}` : '';
}
