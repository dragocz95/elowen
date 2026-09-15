import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', 'prompts');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

// Captured from every bundled template before the Markdown rewrite. Counts preserve repeated slots,
// while exact map equality catches accidental new tokens as well as omissions.
const placeholders: Record<string, Record<string, number>> = {
  // The persona parts. Identity carries every variable; the harness and work parts carry none of their
  // own, except the one place the vendor text names the agent.
  'elowen.md': { '{{agentName}}': 2, '{{userName}}': 1, '{{productName}}': 3, '{{personality}}': 1 },
  'elowen-harness.md': {},
  'elowen-work.md': {},
  'codex-work.md': { '{{agentName}}': 1 },
  'elowen-platform.md': { '{{ownerName}}': 2, '{{productName}}': 1, '{{agentName}}': 1 },
  'scheduled.md': { '{{agentName}}': 1, '{{userName}}': 1, '{{personality}}': 1 },
  'cli/plan-mode.md': { '{{planFile}}': 1, '{{planState}}': 1 },
  'cli/plan-mode-sparse.md': { '{{planFile}}': 1 },
  'cli/workflow-mode.md': {},
  'cli/workflow-mode-sparse.md': {},
  'agents/explore.md': { '${GLOB_TOOL_NAME}': 1, '${GREP_TOOL_NAME}': 1, '${READ_TOOL_NAME}': 1, '${SHELL_TOOL_NAME}': 2 },
  'agents/plan.md': { '${SHELL_TOOL_NAME}': 3, '${GREP_TOOL_NAME}': 1, '${READ_TOOL_NAME}': 1 },
  'agents/review.md': { '${SHELL_TOOL_NAME}': 1 },
};

describe('bundled prompt contracts', () => {
  it('covers every bundled Markdown template', () => {
    const files = readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.md')).sort();
    expect(Object.keys(placeholders).sort()).toEqual(files);
  });

  it.each(Object.entries(placeholders))('preserves the exact placeholder map of %s', (file, expected) => {
    const actual: Record<string, number> = {};
    for (const [token] of read(file).matchAll(/\{\{[^{}]+\}\}|\$\{[^{}]+\}/g)) {
      actual[token] = (actual[token] ?? 0) + 1;
    }
    expect(actual).toEqual(expected);
  });

  it.each(['plan-mode', 'workflow-mode'])('preserves full and sparse %s runtime markers', (mode) => {
    for (const suffix of ['', '-sparse']) {
      const text = read(`cli/${mode}${suffix}.md`).trim();
      expect(text.startsWith(`<system-reminder>\n<${mode}>`)).toBe(true);
      expect(text.endsWith(`</${mode}>\n</system-reminder>`)
        || text.endsWith('</instruction>\n</system-reminder>')).toBe(true);
      expect(text).toContain(`</${mode}>`);
      if (!suffix) expect(text).toMatch(/<instruction>[^<]+<\/instruction>/);
    }
  });

  it('describes asynchronous workflow delivery and the supported file contract', () => {
    const text = read('cli/workflow-mode.md');
    expect(text).toContain('asynchronous by default');
    expect(text).toContain('background=false');
    expect(text).toContain('cannot deliver a later turn');
    expect(text).toContain('{ title?, fork?, nodes, background? }');
    expect(text).toContain('Put shared facts in each node\'s task');
    expect(text).toContain('direct dependencies');
    expect(text).toContain('Do not poll');
    expect(text).not.toContain('`WorkflowStart` BLOCKS');
    expect(text).not.toContain('context?');
    expect(text).not.toContain('in `context`');
  });

  it('keeps plan and review work within the active tool boundary', () => {
    for (const file of ['agents/plan.md', 'agents/review.md', 'cli/plan-mode.md']) {
      expect(read(file)).toContain('shell clamp');
      expect(read(file)).toContain('Do not bypass');
    }
    expect(read('agents/plan.md')).toContain('The designated plan file is the only file you may write');
    expect(read('agents/review.md')).toContain('Do not create worktrees or temporary files');
  });
});
